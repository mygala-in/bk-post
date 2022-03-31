const _ = require('underscore');
const processor = require('./processor');
const logger = require('./bk-utils/logger');
const errors = require('./bk-utils/errors');
const access = require('./bk-utils/access');
const redis = require('./bk-utils/redis.helper');
const snsHelper = require('./bk-utils/sns.helper');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');
const rdsLikes = require('./bk-utils/rds/rds.likes.helper');
const rdsComments = require('./bk-utils/rds/rds.comments.helper');

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

  const [resp, likes] = await Promise.all([rdsPosts.getPostsIn(ids), rdsLikes.likesCountsIn(ids)]);
  for (let i = 0; i < resp.count; i += 1) {
    resp.items[i].likes = { total: likes[i] || 0 };
  }

  resp.total = total;
  return resp;
}


async function likeAction(request) {
  const { decoded, body } = request;
  const parentId = request.pathParameters.id;
  const { postId, type, marriageId } = body;
  const { insertId } = await rdsLikes.saveLike({ parentId, userId: decoded.id, postId, type, isDeleted: false });

  const resp = await rdsLikes.getLike(insertId);
  await snsHelper.pushToSNS('timeline', { action: 'like', ...resp, marriageId });
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


async function commentAction(request) {
  const { decoded, body } = request;
  const parentId = request.pathParameters.id;
  const { postId, type, text, marriageId } = body;
  const { insertId } = await rdsComments.saveComment({ parentId, userId: decoded.id, postId, type, text, isDeleted: false });

  const resp = await rdsComments.getComment(insertId);
  await snsHelper.pushToSNS('timeline', { action: 'comment', ...resp, marriageId });
  return resp;
}


async function uncommentAction(request) {
  const { decoded } = request;
  const { id } = request.pathParameters;

  const comment = await rdsComments.getComment(id);
  if (_.isEmpty(comment)) errors.handleError(404, 'comment not found');
  if (comment.userId !== decoded.id) errors.handleError(401, 'unauthorized');

  await Promise.all([
    rdsComments.deleteComment(id),
    snsHelper.pushToSNS('timeline', { action: 'uncomment', ...comment }),
  ]);
  return { success: true };
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
      case '/v1/{id}/comment':
        switch (request.httpMethod) {
          case 'POST':
            resp = await commentAction(request);
            break;
          case 'PUT':
            break;
          case 'DELETE':
            resp = await uncommentAction(request);
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
