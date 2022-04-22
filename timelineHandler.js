const _ = require('underscore');
const processor = require('./processor');
const logger = require('./bk-utils/logger');
const errors = require('./bk-utils/errors');
const access = require('./bk-utils/access');
const redis = require('./bk-utils/redis.helper');
const constants = require('./bk-utils/constants');
const snsHelper = require('./bk-utils/sns.helper');
const rdsUsers = require('./bk-utils/rds/rds.users.helper');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');
const rdsLikes = require('./bk-utils/rds/rds.likes.helper');
const rdsComments = require('./bk-utils/rds/rds.comments.helper');
const rdsMarriages = require('./bk-utils/rds/rds.marriages.helper');



async function getRecentLikes(ids, type, userId) {
  const resp = { type: 'collection', count: 0, items: [] };
  try {
    if (ids.length === 0) return resp;
    const tasks = [];
    for (let i = 0; i < ids.length; i += 1) {
      tasks.push(redis.lrange(`${type}_${ids[i]}_recent_likes`, 'int'));
    }
    const cache = await Promise.all(tasks);
    const likeIds = _.flatten(cache);
    logger.info('recent like ids', JSON.stringify(likeIds));
    if (likeIds.length > 0) {
      resp.items = await redis.mget(likeIds.map((k) => `like_${k}`), 'json');
      resp.items = resp.items.filter((k) => k !== null);
      resp.count = resp.items.length;
    }
    const missed = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (resp.items.filter((k) => k.parentId === ids[i] && k.userId === userId).length === 0) {
        missed.push(ids[i]);
      }
    }
    logger.info('user missed likes', missed);
    if (missed.length > 0) {
      const [user, likes] = await Promise.all([rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsLikes.searchLikes(userId, missed)]);
      for (let k = 0; k < likes.count; k += 1) {
        const like = likes.items[k];
        like.user = user;
        resp.items.push(like);
      }
      resp.count = resp.items.length;
    }

    logger.info('final recent likes ', JSON.stringify(resp));
  } catch (err) {
    logger.error(err);
  }
  return resp;
}


async function getRecentComments(ids, type) {
  const resp = { type: 'collection', count: 0, items: [] };
  try {
    if (ids.length === 0) return resp;
    const tasks = [];
    for (let i = 0; i < ids.length; i += 1) {
      tasks.push(redis.lrange(`${type}_${ids[i]}_recent_comments`, 'int'));
    }
    const cache = await Promise.all(tasks);
    const commentIds = _.flatten(cache);
    logger.info('recent comment ids', JSON.stringify(commentIds));
    if (commentIds.length === 0) return resp;

    resp.items = await redis.mget(commentIds.map((k) => `comment_${k}`), 'json');
    resp.items = resp.items.filter((k) => k !== null);
    resp.count = resp.items.length;
    logger.info('final recent comments ', JSON.stringify(resp));
  } catch (err) {
    logger.error(err);
  }
  return resp;
}



async function getTimeline(request) {
  const { decoded } = request;
  const { postId, size } = request.queryStringParameters;
  const key = `user_${decoded.id}_timeline`;
  const exists = await redis.exists(key);
  if (!exists) await processor.generateTimeline(decoded.id);

  let [total, rank] = await Promise.all([redis.zcard(key), redis.zrank(key, postId)]);
  rank = rank || 0;
  total = total || 0;
  logger.info({ total, postId, rank });
  if (total === 0) return { entity: 'collection', items: [], count: 0, total };

  const ids = await redis.zrange(key, 'int', rank > 0 ? rank + 1 : rank, rank + size > 100 ? 20 : size);
  logger.info('user timeline post ids', ids);

  const [resp, totalLikes, totalComments, recentLikes, recentComments] = await Promise.all([
    rdsPosts.getPostsIn(ids), rdsLikes.likesCountsIn(ids, 'post'), rdsComments.commentsCountsIn(ids, 'post'), getRecentLikes(ids, 'post', decoded.id),
    getRecentComments(ids, 'post'),
  ]);
  const mIds = _.uniq(_.filter(resp.items.map((r) => r.marriageId), (id) => _.isNumber(id)));
  logger.info('marriage ids ', mIds);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const [users, marriages] = await Promise.all([rdsUsers.getUserFieldsIn(uIds, constants.MINI_PROFILE_FIELDS), rdsMarriages.getMarriagesIn(mIds)]);

  for (let i = 0; i < resp.count; i += 1) {
    if (resp.items[i].userId) [resp.items[i].user] = users.items.filter((u) => u.id === resp.items[i].userId);
    if (resp.items[i].marriageId) [resp.items[i].marriage] = marriages.items.filter((u) => u.id === resp.items[i].marriageId);
    const likes = recentLikes.items.filter((k) => k.parentId === resp.items[i].id);
    resp.items[i].likes = { type: 'collection', total: totalLikes[i] || 0, items: likes, count: likes.length };
    const comments = recentComments.items.filter((k) => k.parentId === resp.items[i].id);
    resp.items[i].comments = { type: 'collection', total: totalComments[i] || 0, items: comments, count: comments.length };
  }

  resp.total = total;
  logger.info('final timeline ', JSON.stringify(resp));
  return resp;
}


async function likeAction(request) {
  const { decoded, body } = request;
  const parentId = request.pathParameters.id;
  const { postId, type } = body;
  const { insertId } = await rdsLikes.saveLike({ parentId, userId: decoded.id, postId, type, isDeleted: false });

  const [resp, user] = await Promise.all([rdsLikes.getLike(insertId), rdsUsers.getUserFields(decoded.id, constants.MINI_PROFILE_FIELDS)]);
  await snsHelper.pushToSNS('timeline', { action: 'like', ...resp });
  resp.user = user;
  return resp;
}


async function unlikeAction(request) {
  const { decoded } = request;
  const { id } = request.pathParameters;

  const like = await rdsLikes.getLike(id);
  if (_.isEmpty(like)) errors.handleError(404, 'like not found');
  if (like.userId !== decoded.id) errors.handleError(401, 'unauthorized');

  await Promise.all([
    rdsLikes.deleteLike(id),
    snsHelper.pushToSNS('timeline', { action: 'unlike', ...like }),
  ]);
  return { success: true };
}


async function newComment(request) {
  const { decoded, body } = request;
  const parentId = request.pathParameters.id;
  const { postId, type, text } = body;
  const { insertId } = await rdsComments.saveComment({ parentId, userId: decoded.id, postId, type, text, isDeleted: false });

  const [resp, user] = await Promise.all([rdsComments.getComment(insertId), rdsUsers.getUserFields(decoded.id, constants.MINI_PROFILE_FIELDS)]);
  await snsHelper.pushToSNS('timeline', { action: 'new-comment', ...resp });
  resp.user = user;
  return resp;
}


async function deleteComment(request) {
  const { decoded } = request;
  const { id } = request.pathParameters;

  const comment = await rdsComments.getComment(id);
  if (_.isEmpty(comment)) errors.handleError(404, 'comment not found');
  if (comment.userId !== decoded.id) errors.handleError(401, 'unauthorized');

  await Promise.all([
    rdsComments.deleteComment(id),
    snsHelper.pushToSNS('timeline', { action: 'delete-comment', ...comment }),
  ]);
  return { success: true };
}


async function editComment(request) {
  const { decoded, body } = request;
  const { id } = request.pathParameters;

  const comment = await rdsComments.getComment(id);
  if (_.isEmpty(comment)) errors.handleError(404, 'comment not found');
  if (comment.userId !== decoded.id) errors.handleError(401, 'unauthorized');

  await Promise.all([
    rdsComments.updateComment(id, { ...body }),
    snsHelper.pushToSNS('timeline', { action: 'edit-comment', ...comment }),
  ]);
  Object.assign(comment, body);
  return comment;
}


async function getComments(request) {
  const { decoded } = request;
  const parentId = request.pathParameters.id;
  const { page } = request.queryStringParameters;

  // TODO - check user is authorized to access requested parent
  const resp = await rdsComments.getComments(parentId, page, 15);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const ids = resp.items.map((r) => r.id);
  const [users, totalLikes, totalComments, recentLikes, recentComments] = await Promise.all([
    rdsUsers.getUserFieldsIn(uIds, constants.MINI_PROFILE_FIELDS),
    rdsLikes.likesCountsIn(ids, 'comment'), rdsComments.commentsCountsIn(ids, 'comment'), getRecentLikes(ids, 'comment', decoded.id),
    getRecentComments(ids, 'comment'),
  ]);
  for (let i = 0; i < resp.count; i += 1) {
    if (resp.items[i].userId) [resp.items[i].user] = users.items.filter((u) => u.id === resp.items[i].userId);
    const likes = recentLikes.items.filter((k) => k.parentId === resp.items[i].id);
    resp.items[i].likes = { type: 'collection', total: totalLikes[i] || 0, items: likes, count: likes.length };
    const comments = recentComments.items.filter((k) => k.parentId === resp.items[i].id);
    resp.items[i].comments = { type: 'collection', total: totalComments[i] || 0, items: comments, count: comments.length };
  }
  return resp;
}


async function getLikes(request) {
  // const { decoded } = request;
  const parentId = request.pathParameters.id;
  const { page } = request.queryStringParameters;

  // TODO - check user is authorized to access requested parent
  const resp = await rdsLikes.getLikes(parentId, page, 15);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const users = await rdsUsers.getUserFieldsIn(uIds, constants.MINI_PROFILE_FIELDS);
  for (let i = 0; i < resp.count; i += 1) {
    if (resp.items[i].userId) [resp.items[i].user] = users.items.filter((u) => u.id === resp.items[i].userId);
  }
  return resp;
}




async function invoke(event, context, callback) {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Credentials': true };
  try {
    const request = access.validateRequest(event, context);

    let resp = {};
    switch (request.resourcePath) {
      case '/v1/list':
        resp = await getTimeline(request);
        break;

      case '/v1/{id}/like':
        if (request.httpMethod === 'PUT') resp = await likeAction(request);
        else if (request.httpMethod === 'DELETE') resp = await unlikeAction(request);
        break;

      case '/v1/{id}/likes':
        resp = await getLikes(request);
        break;

      case '/v1/{id}/comments':
        resp = await getComments(request);
        break;

      case '/v1/{id}/comment':
        switch (request.httpMethod) {
          case 'POST':
            resp = await newComment(request);
            break;
          case 'PUT':
            resp = await editComment(request);
            break;
          case 'DELETE':
            resp = await deleteComment(request);
            break;
          default:
        }
        break;

      default: errors.handleError(400, 'invalid request path');
    }
    context.callbackWaitsForEmptyEventLoop = false;
    return callback(null, { statusCode: 200, headers, body: JSON.stringify(resp) });
  } catch (err) {
    context.callbackWaitsForEmptyEventLoop = false;
    logger.error('error processing api');
    logger.error(err);
    return callback(null, { headers, ...err });
  }
}

module.exports = {
  invoke,
};
