const processor = require('./processor');
const logger = require('./bk-utils/logger');
const errors = require('./bk-utils/errors');
const access = require('./bk-utils/access');
const redis = require('./bk-utils/redis.helper');
const snsHelper = require('./bk-utils/sns.helper');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');


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
  let resp = { entity: 'collection', items: [], count: 0, total };
  if (total === 0) return resp;

  const ids = await redis.zrange(key, 'int', rank > 0 ? rank + 1 : rank, rank + size > 100 ? 20 : size);
  logger.info('user timeline post ids', ids);

  resp = await rdsPosts.getPostsIn(ids);
  resp.total = total;
  return resp;
}

async function likeAction(request) {
  const { decoded, body } = request;
  const { parentId } = request.pathParameters;
  await Promise.all([
    redis.incr(`${parentId}_likes`),
    snsHelper.pushToSNS('timeline', { action: 'like', parentId, ...body, userId: decoded.id }),
  ]);
  return { success: true };
}


async function unlikeAction(request) {
  const { decoded, body } = request;
  const { parentId } = request.pathParameters;
  await Promise.all([
    redis.decr(`${parentId}_likes`),
    snsHelper.pushToSNS('timeline', { action: 'unlike', parentId, ...body, userId: decoded.id }),
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
      case '/v1/{parentId}/like':
        if (request.httpMethod === 'PUT') resp = await likeAction(request);
        else if (request.httpMethod === 'DELETE') resp = await unlikeAction(request);
        break;
      case '/v1/{parentId}/comment':
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
