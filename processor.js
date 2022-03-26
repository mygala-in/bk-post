/* eslint-disable no-await-in-loop */
const logger = require('./bk-utils/logger');
const redis = require('./bk-utils/redis.helper');
const constants = require('./bk-utils/constants');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');
const rdsUsers = require('./bk-utils/rds/rds.users.helper');
const rdsMUsers = require('./bk-utils/rds/rds.marriage.users.helper');

const { MINI_PROFILE_FIELDS } = constants;
const { STATUS } = constants.MARRIAGE_CONFIG;

async function savePost(message) {
  logger.info('saving post');
  const { type, userId } = message;
  let user;
  let insertId;

  switch (type) {
    case 'marriage.join':
      // {"marriageId":"3","userId":"2","type":"marriage.join","assetType":"jpg","resourceType":0}
      user = await rdsUsers.getUserFields(userId, MINI_PROFILE_FIELDS);
      Object.assign(message, { url: user.photo, meta: JSON.stringify(user) });
      ({ insertId } = await rdsPosts.insertPost(message));
      await rdsPosts.getPost(insertId);
      break;

    case 'marriage.post':
      user = await rdsUsers.getUserFields(userId, MINI_PROFILE_FIELDS);
      Object.assign(message, { meta: JSON.stringify(user) });
      ({ insertId } = await rdsPosts.insertPost(message));
      await rdsPosts.getPost(insertId);
      break;

    default:
      logger.warn(`unhandled post type ${type}`);
  }
  return insertId;
}


async function removePost(message) {
  logger.info('removing post');
  const { type } = message;

  let postId;
  switch (type) {
    case 'marriage.join':
      postId = await rdsPosts.queryPost(message);
      break;

    case 'marriage.post':
      ({ postId } = message.postId);
      break;

    default:
  }
  await rdsPosts.deletePost(postId);
  return postId;
}



async function addToTimelines(postId, message) {
  const { marriageId } = message;
  logger.info('adding post to user timelines ', postId, JSON.stringify(message));
  const mUsers = await rdsMUsers.getUsers(marriageId);
  const ids = mUsers.items.map((user) => user.userId);
  logger.info('total marriage users ', ids.length);
  for (let i = 0; i < ids.length; i += 1) {
    const key = `user_${ids[i]}_timeline`;
    const exists = await redis.exists(key);
    if (exists) {
      await redis.zadd(key, postId, postId);
      // await redis.expire(key, REDIS_CONFIG.timeline.user);
    } else logger.info('skipping timeline update for ', key);
  }
  logger.info('completed adding post to user timelines');
}


async function removeFromTimelines(postId, message) {
  const { marriageId } = message;
  logger.info('removing post from user timelines ', postId, JSON.stringify(message));

  const mUsers = await rdsMUsers.getUsers(marriageId);
  const ids = mUsers.items.map((user) => user.userId);
  logger.info('total marriage users ', ids.length);
  for (let i = 0; i < ids.length; i += 1) {
    const key = `user_${ids[i]}_timeline`;
    const exists = await redis.exists(key);
    if (exists) {
      await redis.zrem(key, postId);
    } else logger.info('skipping timeline update for ', key);
  }
  logger.info('completed removing post from user timelines');
}


async function generateTimeline(userId) {
  logger.info('started generating timeline for user ', userId);
  const mJoins = await rdsMUsers.getMarriages(userId);
  const vIds = mJoins.items.filter((i) => i.status === STATUS.verified).map((i) => i.marriageId);
  logger.info('verified marriage ids ', vIds);

  const postIds = await rdsPosts.getMarriagePostIds(vIds);
  logger.info('total posts ', postIds.count);
  const tasks = [];
  for (let i = 0; i < postIds.count; i += 1) {
    const id = postIds.items[i];
    tasks.push(redis.zadd(`user_${userId}_timeline`, id, id));
  }
  await Promise.all(tasks);
  logger.info('completed generating timeline for user');
}


async function sns(request) {
  logger.info('received timeline event sns');
  logger.info(JSON.stringify(request));
  try {
    const message = JSON.parse(request.Records[0].Sns.Message);
    logger.info(JSON.stringify(message));
    const { action } = message;
    delete message.action;

    if (action === 'add') {
      const id = await savePost(message);
      await addToTimelines(id, message);
    } else if (action === 'remove') {
      const id = await removePost(message);
      await removeFromTimelines(id, message);
    } else logger.warn('invalid post action received');
  } catch (err) {
    logger.error(err);
  }
}


module.exports = {
  sns,
  generateTimeline,
};
