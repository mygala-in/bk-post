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
const rdsAssets = require('./bk-utils/rds/rds.assets.helper');
const rdsComments = require('./bk-utils/rds/rds.comments.helper');
const rdsMarriages = require('./bk-utils/rds/rds.marriages.helper');
const rdsMUsers = require('./bk-utils/rds/rds.marriage.users.helper');

const { MARRIAGE_CONFIG, MINI_PROFILE_FIELDS, ASSET_RESOURCE_TYPES } = constants;

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
    logger.info('cached likes ', resp);
    const missed = [];
    for (let i = 0; i < ids.length; i += 1) {
      if (resp.items.filter((k) => k.parentId === ids[i] && k.userId === userId).length === 0) {
        missed.push(ids[i]);
      }
    }
    logger.info('user missed likes', missed);
    if (missed.length > 0) {
      const [user, likes] = await Promise.all([rdsUsers.getUserFields(userId, MINI_PROFILE_FIELDS), rdsLikes.searchLikes(userId, missed, type)]);
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

async function postsAfter(key, postId, size) {
  const total = await redis.zcard(key);
  logger.info('total timeline items ', total);
  let rank = await redis.zrank(key, postId);
  if (rank == null) rank = 0;
  else rank += 1;
  logger.info(`rank ${rank}`);
  const [st, end] = [rank, rank + size - 1];
  if (st >= total) return { ids: [], total };
  const ids = await redis.zrange(key, 'int', st, end);
  return { ids, total };
}

async function postsBefore(key, postId, size) {
  const total = await redis.zcard(key);
  logger.info('total timeline items ', total);
  let rank = await redis.zrevrank(key, postId);
  if (rank == null) rank = 0;
  else rank += 1;
  logger.info(`rank ${rank}`);
  const [st, end] = [rank, rank + size - 1];
  if (st >= total) return { ids: [], total };
  const ids = await redis.zrevrange(key, 'int', st, end);
  return { ids, total };
}

async function recentPosts(key, size) {
  const total = await redis.zcard(key);
  logger.info('total timeline items ', total);
  const [st, end] = [0, size - 1];
  const ids = await redis.zrevrange(key, 'int', st, end);
  return { ids, total };
}


async function timelinePosts(action, key, postId, size) {
  switch (action) {
    case 'recent':
      return recentPosts(key, size);
    case 'after':
      return postsAfter(key, postId, size);
    case 'before':
      return postsBefore(key, postId, size);
    default:
      return { ids: [], total: 0 };
  }
}


async function getTimeline(request) {
  const { decoded } = request;
  const { action } = request.queryStringParameters;
  let { postId, size } = request.queryStringParameters;
  postId = parseInt(postId, 10);
  size = parseInt(size, 10);
  const key = `user_${decoded.id}_timeline`;
  const exists = await redis.exists(key);
  if (!exists) await processor.generateTimeline(decoded.id);

  const { ids, total } = await timelinePosts(action, key, postId, size);
  logger.info('paginated timeline items ', ids);
  if (total === 0 || ids.length === 0) return { entity: 'collection', items: [], count: 0, total };

  const [assets, resp, totalLikes, totalComments, recentLikes, recentComments] = await Promise.all([
    rdsAssets.getPostAssetsIn(ASSET_RESOURCE_TYPES.timeline, ids),
    rdsPosts.getPostsIn(ids), rdsLikes.likesCountsIn(ids, 'post'), rdsComments.commentsCountsIn(ids, 'post'), getRecentLikes(ids, 'post', decoded.id),
    getRecentComments(ids, 'post'),
  ]);
  logger.info('total assets ', assets.count);
  const mIds = _.uniq(_.filter(resp.items.map((r) => r.marriageId), (id) => _.isNumber(id)));
  logger.info('marriage ids ', mIds);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const [users, marriages] = await Promise.all([rdsUsers.getUserFieldsIn(uIds, MINI_PROFILE_FIELDS), rdsMarriages.getMarriagesIn(mIds)]);

  for (let i = 0; i < resp.count; i += 1) {
    if (resp.items[i].userId) [resp.items[i].user] = users.items.filter((u) => u.id === resp.items[i].userId);
    if (resp.items[i].marriageId) [resp.items[i].marriage] = marriages.items.filter((u) => u.id === resp.items[i].marriageId);
    const postLikes = recentLikes.items.filter((k) => k.parentId === resp.items[i].id);
    resp.items[i].likes = { type: 'collection', total: totalLikes[i] || 0, items: postLikes, count: postLikes.length };
    const postComments = recentComments.items.filter((k) => k.parentId === resp.items[i].id);
    resp.items[i].comments = { type: 'collection', total: totalComments[i] || 0, items: postComments, count: postComments.length };
    const postAssets = assets.items.filter((k) => k.postId === resp.items[i].id);
    resp.items[i].assets = { type: 'collection', total: postAssets.length, items: postAssets, count: postAssets.length };
  }

  resp.total = total;
  logger.info('final timeline ', JSON.stringify(resp));
  return resp;
}


async function newPost(request) {
  const { decoded, body } = request;
  let muObj;
  switch (body.type) {
    case 'marriage.post':
      if (!body.marriageId) errors.handleError(400, 'marriageId is required');
      muObj = await rdsMUsers.getUser(body.marriageId, decoded.id);
      logger.info('requested user ', muObj);
      if (_.isEmpty(muObj)) errors.handleError(404, 'no association with requested marriage');
      if (muObj.status !== MARRIAGE_CONFIG.STATUS.verified) errors.handleError(401, 'unauthorized');
      break;

    default: errors.handleError(400, `unhandled post type ${body.type}`);
  }
  const { insertId } = await rdsPosts.insertPost({ userId: decoded.id, ...body });
  const resp = await rdsPosts.getPost(insertId);
  logger.info('final response ', JSON.stringify(resp));
  return resp;
}


async function updatePost(request) {
  const { decoded, body } = request;
  const { id } = request.pathParameters;
  const post = await rdsPosts.getPost(id);
  if (_.isEmpty(post)) errors.handleError(404, 'post not found');
  if (post.userId !== decoded.id) errors.handleError(401, 'unauthorized');
  await rdsPosts.updatePost(id, body);

  const resp = await rdsPosts.getPost(id);
  logger.info('final response ', JSON.stringify(resp));
  return resp;
}


async function deletePost(request) {
  const { decoded } = request;
  const { id } = request.pathParameters;
  const post = await rdsPosts.getPost(id);
  if (_.isEmpty(post)) errors.handleError(404, 'post not found');
  if (post.userId !== decoded.id) errors.handleError(401, 'unauthorized');
  await Promise.all([rdsPosts.deletePost(id), snsHelper.pushToSNS('timeline-bg-tasks', { action: 'delete', component: 'post', postId: id, marriageId: post.marriageId })]);
  return { success: true };
}

async function getPost(request) {
  const { decoded } = request;
  const { id } = request.pathParameters;
  const resp = await rdsPosts.getPost(id);
  if (_.isEmpty(resp)) errors.handleError(404, 'post not found');
  const { userId, marriageId } = resp;
  if (marriageId) {
    const muObj = await rdsMUsers.getUser(marriageId, decoded.id);
    logger.info('requested user ', muObj);
    if (_.isEmpty(muObj)) errors.handleError(404, 'no association with requested marriage');
    if (muObj.status !== MARRIAGE_CONFIG.STATUS.verified) errors.handleError(401, 'unauthorized');
  }
  const tasks = [];
  tasks.push(rdsUsers.getUserFields(userId, MINI_PROFILE_FIELDS));
  tasks.push(rdsAssets.getPostAssets(ASSET_RESOURCE_TYPES.timeline, id));
  tasks.push(rdsLikes.likesCountsIn([id], 'post'));
  tasks.push(rdsComments.commentsCountsIn([id], 'post'));
  tasks.push(getRecentLikes([id], 'post', decoded.id));
  tasks.push(getRecentComments([id], 'post'));
  if (marriageId) tasks.push(rdsMarriages.getMarriage(marriageId));
  const [user, assets, totalLikes, totalComments, recentLikes, recentComments, marriage] = await Promise.all(tasks);
  resp.user = user;
  resp.assets = assets;
  resp.likes = { type: 'collection', total: totalLikes[0], items: recentLikes.items, count: recentLikes.items.length };
  resp.comments = { type: 'collection', total: totalComments[0], items: recentComments.items, count: recentComments.items.length };
  if (marriage) resp.marriage = marriage;
  logger.info('final response ', JSON.stringify(resp));
  return resp;
}


async function likeAction(request) {
  const { decoded, body } = request;
  const parentId = request.pathParameters.id;
  const { postId, type } = body;
  const { insertId } = await rdsLikes.saveLike({ parentId, userId: decoded.id, postId, type, isDeleted: false });

  const [resp, user] = await Promise.all([rdsLikes.getLike(insertId), rdsUsers.getUserFields(decoded.id, MINI_PROFILE_FIELDS)]);
  await snsHelper.pushToSNS('timeline-bg-tasks', { action: 'add', component: 'like', ...resp });
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
    snsHelper.pushToSNS('timeline-bg-tasks', { action: 'delete', component: 'like', ...like }),
  ]);
  return { success: true };
}


async function newComment(request) {
  const { decoded, body } = request;
  const parentId = request.pathParameters.id;
  const { postId, type, text } = body;
  const { insertId } = await rdsComments.saveComment({ parentId, userId: decoded.id, postId, type, text, isDeleted: false });

  const [resp, user] = await Promise.all([rdsComments.getComment(insertId), rdsUsers.getUserFields(decoded.id, MINI_PROFILE_FIELDS)]);
  await snsHelper.pushToSNS('timeline-bg-tasks', { action: 'add', component: 'comment', ...resp });
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
    snsHelper.pushToSNS('timeline-bg-tasks', { action: 'delete', component: 'comment', ...comment }),
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
    snsHelper.pushToSNS('timeline-bg-tasks', { action: 'edit', component: 'comment', ...comment }),
  ]);
  Object.assign(comment, body);
  return comment;
}


async function getComments(request) {
  const { decoded } = request;
  const parentId = request.pathParameters.id;
  const { type, page, size } = request.queryStringParameters;

  // TODO - check user is authorized to access requested parent
  const [resp, total] = await Promise.all([rdsComments.getComments(parentId, type, page, size), rdsComments.commentsCountsIn([parentId], type)]);
  [resp.total] = total;
  resp.page = parseInt(page, 10);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const commentIds = resp.items.map((r) => r.id);
  const [users, totalLikes, totalComments, recentLikes, recentComments] = await Promise.all([
    rdsUsers.getUserFieldsIn(uIds, MINI_PROFILE_FIELDS),
    rdsLikes.likesCountsIn(commentIds, 'comment'), rdsComments.commentsCountsIn(commentIds, 'comment'), getRecentLikes(commentIds, 'comment', decoded.id),
    getRecentComments(commentIds, 'comment'),
  ]);
  for (let i = 0; i < resp.count; i += 1) {
    if (resp.items[i].userId) [resp.items[i].user] = users.items.filter((u) => u.id === resp.items[i].userId);
    const likes = recentLikes.items.filter((k) => k.parentId === resp.items[i].id);
    resp.items[i].likes = { type: 'collection', total: totalLikes[i] || 0, items: likes, count: likes.length };
    const comments = recentComments.items.filter((k) => k.parentId === resp.items[i].id);
    resp.items[i].replies = { type: 'collection', total: totalComments[i] || 0, items: comments, count: comments.length };
  }
  logger.info('final response ', JSON.stringify(resp));
  return resp;
}


async function getLikes(request) {
  // const { decoded } = request;
  const parentId = request.pathParameters.id;
  const { type, page, size } = request.queryStringParameters;

  // TODO - check user is authorized to access requested parent
  const [resp, total] = await Promise.all([rdsLikes.getLikes(parentId, type, page, size), rdsLikes.likesCountsIn([parentId], type)]);
  [resp.total] = total;
  resp.page = parseInt(page, 10);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const users = await rdsUsers.getUserFieldsIn(uIds, constants.MINI_PROFILE_FIELDS);
  for (let i = 0; i < resp.count; i += 1) {
    if (resp.items[i].userId) [resp.items[i].user] = users.items.filter((u) => u.id === resp.items[i].userId);
  }
  logger.info('final response ', JSON.stringify(resp));
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

      case '/v1/new':
        resp = await newPost(request);
        break;

      case '/v1/{id}':
        switch (request.httpMethod) {
          case 'GET': resp = await getPost(request); break;
          case 'PUT': resp = await updatePost(request); break;
          case 'DELETE': resp = await deletePost(request); break;
          default: errors.handleError(400, 'invalid request method');
        }
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
