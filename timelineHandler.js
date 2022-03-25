/* eslint-disable no-await-in-loop */
const logger = require('./bk-utils/logger');
const redis = require('./bk-utils/redis.helper');
const constants = require('./bk-utils/constants');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');
const rdsUsers = require('./bk-utils/rds/rds.users.helper');
const rdsMUsers = require('./bk-utils/rds/rds.marriage.users.helper');

const { MINI_PROFILE_FIELDS } = constants;

async function savePost(message) {
  logger.info('saving post');
  const { type, userId, marriageId, assetType, resourceType } = message;
  let user;
  let insertId;

  switch (type) {
    case 'marriage.join':
      user = await rdsUsers.getUserFields(userId, MINI_PROFILE_FIELDS);
      ({ insertId } = await rdsPosts.insertPost({ type, userId, marriageId, assetType, resourceType, url: user.photo, meta: JSON.stringify(user) }));
      await rdsPosts.getPost(insertId);
      break;

    case 'marriage.remove':
      break;

    default:
  }
  return insertId;
}


async function updateTimeline(id, message) {
  const { marriageId } = message;
  logger.info('updating user timelines');
  const mUsers = await rdsMUsers.getUsers(marriageId);
  const ids = mUsers.items.map((user) => user.userId);
  logger.info('total marriage users ', ids.length);
  for (let i = 0; i < ids.length; i += 1) {
    const key = `user_${ids[i]}_timeline`;
    const exists = await redis.exists(key);
    if (exists) {
      await redis.zadd(key, id, id);
      // await redis.expire(key, REDIS_CONFIG.timeline.user);
    } else logger.info('skipping timeline update for ', key);
  }
}


async function invoke(request) {
  logger.info('received timeline event');
  logger.info(JSON.stringify(request));
  try {
    const message = JSON.parse(request.Records[0].Sns.Message);
    logger.info(message);
    const id = await savePost(message);
    await updateTimeline(id, message);
  } catch (err) {
    logger.error(err);
  }
}

module.exports = {
  invoke,
};
