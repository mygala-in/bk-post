const _ = require('underscore');
const logger = require('./bk-utils/logger');
const errors = require('./bk-utils/errors');
const access = require('./bk-utils/access');
const redis = require('./bk-utils/redis.helper');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');


async function getTimeline(request) {
  const { decoded } = request;
  const { postId, size } = request.queryStringParameters;
  const key = `user_${decoded.id}_timeline`;
  const exists = await redis.exists(key);
  if (!exists) {
    // TODO - re-generate user timeline
  }
  const [total, rank] = await Promise.all([redis.zcard(key), redis.zrank(key, postId)]);
  const resp = { entity: 'collection', items: [], count: 0, total };
  if (total === 0) return resp;

  const ids = await redis.zrange(key, 'int', rank + 1, rank + size > 100 ? 20 : size);
  logger.info('user timeline post ids', ids);
  const posts = await rdsPosts.getPostsIn(ids);

  resp.items = _.sortBy(posts.items, 'id');
  resp.count = resp.items.count;
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
