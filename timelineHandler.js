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
const rdsWeddings = require('./bk-utils/rds/rds.weddings.helper');
const rdsWUsers = require('./bk-utils/rds/rds.wedding.users.helper');

const { WEDDING_CONFIG, MINI_PROFILE_FIELDS } = constants;


/*
  this module is responsible for doing 2 things.
  1. get the recent likes for the parentIds [only from cache]
  2. whether the person requesting recent likes has himself liked each of the parentIds or not. [hence userId argument is used]
*/
async function getRecentLikes(parentIds, userId) {
  const resp = { type: 'collection', count: 0, items: [] };
  try {
    if (parentIds.length === 0) return resp;
    const tasks = [];
    for (let i = 0; i < parentIds.length; i += 1) {
      tasks.push(redis.lrange(`${redis.transformKey(parentIds[i])}_recent_likes`, 'int'));
    }
    const cache = await Promise.all(tasks);
    const likeIds = _.flatten(cache);
    logger.info('recent like ids', JSON.stringify(likeIds));
    if (likeIds.length > 0) {
      resp.items = await redis.mget(likeIds.map((k) => `{like}_${k}`), 'json');
      resp.items = resp.items.filter((k) => k !== null);
      resp.count = resp.items.length;
    }
    logger.info('cached likes ', resp);
    const missed = [];
    for (let i = 0; i < parentIds.length; i += 1) {
      if (resp.items.filter((k) => k.parentId === parentIds[i] && k.userId === userId).length === 0) {
        missed.push(parentIds[i]);
      }
    }
    logger.info('user missed likes', missed);
    if (missed.length > 0) {
      const [user, likes] = await Promise.all([rdsUsers.getUserFields(userId, MINI_PROFILE_FIELDS), rdsLikes.searchLikes(userId, missed)]);
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



/*
  this module is responsible for
  1. get the recent comments for the parentIds [only from cache]
*/
async function getRecentComments(parentIds) {
  const resp = { type: 'collection', count: 0, items: [] };
  try {
    if (parentIds.length === 0) return resp;
    const tasks = [];
    for (let i = 0; i < parentIds.length; i += 1) {
      tasks.push(redis.lrange(`${redis.transformKey(parentIds[i])}_recent_comments`, 'int'));
    }
    const cache = await Promise.all(tasks);
    const commentIds = _.flatten(cache);
    logger.info('recent comment ids', JSON.stringify(commentIds));
    if (commentIds.length === 0) return resp;

    resp.items = await redis.mget(commentIds.map((k) => `{comment}_${k}`), 'json');
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
  const key = redis.transformKey(`user_${decoded.id}_timeline`);
  const exists = await redis.exists(key);
  if (!exists) await processor.generateUserTimeline(decoded.id);

  const { ids, total } = await timelinePosts(action, key, postId, size);
  logger.info('paginated timeline items ', ids);
  if (total === 0 || ids.length === 0) return { entity: 'collection', items: [], count: 0, total };

  const parentIds = ids.map((i) => `post_${i}`);

  const [resp, assets, totalLikes, totalComments, recentLikes, recentComments] = await Promise.all([
    rdsPosts.getPostsIn(ids), rdsAssets.getParentAssetsIn(parentIds),
    rdsLikes.likesCountsIn(parentIds), rdsComments.commentsCountsIn(parentIds),
    getRecentLikes(parentIds, decoded.id), getRecentComments(parentIds),
  ]);
  logger.info('total assets ', assets.count);
  const mIds = _.uniq(_.filter(resp.items.map((r) => r.weddingId), (id) => _.isNumber(id)));
  logger.info('wedding ids ', mIds);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const [users, weddings] = await Promise.all([rdsUsers.getUserFieldsIn(uIds, MINI_PROFILE_FIELDS), rdsWeddings.getWeddingsIn(mIds)]);

  for (let i = 0; i < resp.count; i += 1) {
    const post = resp.items[i];
    if (post.userId) [post.user] = users.items.filter((u) => u.id === post.userId);
    if (post.weddingId) [post.wedding] = weddings.items.filter((u) => u.id === post.weddingId);
    const pLikes = recentLikes.items.filter((k) => k.parentId === `post_${post.id}`);
    post.likes = { type: 'collection', total: totalLikes[i] || 0, items: pLikes, count: pLikes.length };
    const pComments = recentComments.items.filter((k) => k.parentId === `post_${post.id}`);
    post.comments = { type: 'collection', total: totalComments[i] || 0, items: pComments, count: pComments.length };
    const pAssets = assets.items.filter((k) => k.parentId === `post_${post.id}`);
    post.assets = { type: 'collection', total: pAssets.length, items: pAssets, count: pAssets.length };
    resp.items[i] = post;
  }
  resp.total = total;
  return resp;
}


async function getWeddingTimeline(request) {
  const { decoded } = request;
  const { weddingId } = request.pathParameters;
  const { action } = request.queryStringParameters;
  let { postId, size } = request.queryStringParameters;
  postId = parseInt(postId, 10);
  size = parseInt(size, 10);

  const muObj = await rdsWUsers.getUser(weddingId, decoded.id);
  logger.info('requested user ', muObj);
  if (_.isEmpty(muObj)) errors.handleError(404, 'no association with requested wedding');

  const key = redis.transformKey(`wedding_${weddingId}_timeline`);
  if (!await redis.exists(key)) await processor.generateWeddingTimeline(weddingId);

  const { ids, total } = await timelinePosts(action, key, postId, size);
  logger.info('paginated timeline items ', ids);
  if (total === 0 || ids.length === 0) return { entity: 'collection', items: [], count: 0, total };

  const parentIds = ids.map((i) => `post_${i}`);
  const [resp, assets, totalLikes, totalComments, recentLikes, recentComments] = await Promise.all([
    rdsPosts.getPostsIn(ids), rdsAssets.getParentAssetsIn(parentIds),
    rdsLikes.likesCountsIn(parentIds), rdsComments.commentsCountsIn(parentIds),
    getRecentLikes(parentIds, decoded.id), getRecentComments(parentIds),
  ]);
  logger.info('total assets ', assets.count);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const users = await rdsUsers.getUserFieldsIn(uIds, MINI_PROFILE_FIELDS);

  for (let i = 0; i < resp.count; i += 1) {
    const post = resp.items[i];
    if (post.userId) [post.user] = users.items.filter((u) => u.id === post.userId);
    const pLikes = recentLikes.items.filter((k) => k.parentId === `post_${post.id}`);
    post.likes = { type: 'collection', total: totalLikes[i] || 0, items: pLikes, count: pLikes.length };
    const pComments = recentComments.items.filter((k) => k.parentId === `post_${post.id}`);
    post.comments = { type: 'collection', total: totalComments[i] || 0, items: pComments, count: pComments.length };
    const pAssets = assets.items.filter((k) => k.parentId === `post_${post.id}`);
    post.assets = { type: 'collection', total: pAssets.length, items: pAssets, count: pAssets.length };
    resp.items[i] = post;
  }
  resp.total = total;
  return resp;
}


async function newPost(request) {
  const { decoded, body } = request;
  let muObj;
  switch (body.type) {
    case 'wedding.post':
      if (!body.weddingId) errors.handleError(400, 'weddingId is required');
      muObj = await rdsWUsers.getUser(body.weddingId, decoded.id);
      logger.info('requested user ', muObj);
      if (_.isEmpty(muObj)) errors.handleError(404, 'no association with requested wedding');
      if (muObj.status !== WEDDING_CONFIG.status.verified) errors.handleError(401, 'unauthorized');
      break;

    default: errors.handleError(400, `unhandled post type ${body.type}`);
  }
  const { insertId } = await rdsPosts.insertPost({ userId: decoded.id, ...body });
  return rdsPosts.getPost(insertId);
}


async function updatePost(request) {
  const { decoded, body } = request;
  const { id } = request.pathParameters;
  const post = await rdsPosts.getPost(id);
  if (_.isEmpty(post)) errors.handleError(404, 'post not found');
  if (post.userId !== decoded.id) errors.handleError(401, 'unauthorized');
  await rdsPosts.updatePost(id, body);
  return rdsPosts.getPost(id);
}


async function deletePost(request) {
  const { decoded } = request;
  const { id } = request.pathParameters;
  const post = await rdsPosts.getPost(id);
  if (_.isEmpty(post)) errors.handleError(404, 'post not found');
  if (post.userId !== decoded.id) errors.handleError(401, 'unauthorized');
  await Promise.all([rdsPosts.deletePost(id), snsHelper.pushToSNS('timeline-bg-tasks', { service: 'timeline', component: 'post', action: 'delete', data: { postId: id, weddingId: post.weddingId } })]);
  return { success: true };
}

async function getPost(request) {
  const { decoded } = request;
  const { id } = request.pathParameters;
  const resp = await rdsPosts.getPost(id);
  if (_.isEmpty(resp)) errors.handleError(404, 'post not found');
  const { userId, weddingId } = resp;
  if (weddingId) {
    const muObj = await rdsWUsers.getUser(weddingId, decoded.id);
    logger.info('requested user ', muObj);
    if (_.isEmpty(muObj)) errors.handleError(404, 'no association with requested wedding');
    if (muObj.status !== WEDDING_CONFIG.status.verified) errors.handleError(401, 'unauthorized');
  }
  const tasks = [];
  tasks.push(rdsUsers.getUserFields(userId, MINI_PROFILE_FIELDS));
  tasks.push(rdsAssets.getParentAssets(`post_${id}`));
  tasks.push(rdsLikes.likesCountsIn([id], 'post'));
  tasks.push(rdsComments.commentsCountsIn([id], 'post'));
  tasks.push(getRecentLikes([`post_${id}`], decoded.id));
  tasks.push(getRecentComments([`post_${id}`]));
  if (weddingId) tasks.push(rdsWeddings.getWedding(weddingId));
  const [user, assets, totalLikes, totalComments, recentLikes, recentComments, wedding] = await Promise.all(tasks);
  resp.user = user;
  resp.assets = assets;
  resp.likes = { type: 'collection', total: totalLikes[0], items: recentLikes.items, count: recentLikes.items.length };
  resp.comments = { type: 'collection', total: totalComments[0], items: recentComments.items, count: recentComments.items.length };
  if (wedding) resp.wedding = wedding;
  return resp;
}


async function likeAction(request) {
  const { decoded } = request;
  const parentId = request.pathParameters.id;
  const { insertId } = await rdsLikes.saveLike({ parentId, userId: decoded.id, isDeleted: false });

  const [resp, user] = await Promise.all([rdsLikes.getLike(insertId), rdsUsers.getUserFields(decoded.id, MINI_PROFILE_FIELDS)]);
  await snsHelper.pushToSNS('timeline-bg-tasks', { service: 'timeline', component: 'like', action: 'add', data: resp });
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
    snsHelper.pushToSNS('timeline-bg-tasks', { service: 'timeline', component: 'like', action: 'delete', data: like }),
  ]);
  return { success: true };
}


async function newComment(request) {
  const { decoded, body } = request;
  const parentId = request.pathParameters.id;
  const { insertId } = await rdsComments.saveComment({ parentId, userId: decoded.id, text: body.text, isDeleted: false });

  const [resp, user] = await Promise.all([rdsComments.getComment(insertId), rdsUsers.getUserFields(decoded.id, MINI_PROFILE_FIELDS)]);
  await snsHelper.pushToSNS('timeline-bg-tasks', { service: 'timeline', component: 'comment', action: 'add', data: resp });
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
    snsHelper.pushToSNS('timeline-bg-tasks', { service: 'timeline', component: 'comment', action: 'delete', data: comment }),
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
    snsHelper.pushToSNS('timeline-bg-tasks', { service: 'timeline', component: 'comment', action: 'edit', data: comment }),
  ]);
  Object.assign(comment, body);
  return comment;
}


async function getComments(request) {
  const { decoded } = request;
  const parentId = request.pathParameters.id;
  const { page, size } = request.queryStringParameters;

  // TODO - check user is authorized to access requested parent
  const [resp, total] = await Promise.all([rdsComments.getComments(parentId, page, size), rdsComments.commentsCountsIn([parentId])]);
  [resp.total] = total;
  resp.page = parseInt(page, 10);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const commentIds = resp.items.map((r) => r.id);
  const [users, totalLikes, totalComments, recentLikes, recentComments] = await Promise.all([
    rdsUsers.getUserFieldsIn(uIds, MINI_PROFILE_FIELDS),
    rdsLikes.likesCountsIn(commentIds, 'comment'), rdsComments.commentsCountsIn(commentIds, 'comment'), getRecentLikes(commentIds.map((c) => `comment_${c}`), decoded.id),
    getRecentComments(commentIds.map((c) => `comment_${c}`)),
  ]);
  for (let i = 0; i < resp.count; i += 1) {
    const comment = resp.items[i];
    if (comment.userId) [comment.user] = users.items.filter((u) => u.id === comment.userId);
    const likes = recentLikes.items.filter((k) => k.parentId === `comment_${comment.id}`);
    comment.likes = { type: 'collection', total: totalLikes[i] || 0, items: likes, count: likes.length };
    const comments = recentComments.items.filter((k) => k.parentId === `comment_${comment.id}`);
    comment.replies = { type: 'collection', total: totalComments[i] || 0, items: comments, count: comments.length };
    resp.items[i] = comment;
  }
  return resp;
}


async function getLikes(request) {
  // const { decoded } = request;
  const parentId = request.pathParameters.id;
  const { page, size } = request.queryStringParameters;

  // TODO - check user is authorized to access requested parent
  const [resp, total] = await Promise.all([rdsLikes.getLikes(parentId, page, size), rdsLikes.likesCountsIn([parentId])]);
  [resp.total] = total;
  resp.page = parseInt(page, 10);
  const uIds = _.uniq(_.filter(resp.items.map((r) => r.userId), (id) => _.isNumber(id)));
  logger.info('user ids ', uIds);
  const users = await rdsUsers.getUserFieldsIn(uIds, constants.MINI_PROFILE_FIELDS);
  for (let i = 0; i < resp.count; i += 1) {
    const like = resp.items[i];
    if (like.userId) [like.user] = users.items.filter((u) => u.id === like.userId);
    resp.items[i] = like;
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

      case '/v1/wedding/{weddingId}/list':
        resp = await getWeddingTimeline(request);
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
    logger.info('final response ', JSON.stringify(resp));
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
