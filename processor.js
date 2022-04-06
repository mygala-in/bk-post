/* eslint-disable no-await-in-loop */
const _ = require('underscore');
const logger = require('./bk-utils/logger');
const errors = require('./bk-utils/errors');
const redis = require('./bk-utils/redis.helper');
const constants = require('./bk-utils/constants');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');
const rdsLikes = require('./bk-utils/rds/rds.likes.helper');
const rdsUsers = require('./bk-utils/rds/rds.users.helper');
const rdsComments = require('./bk-utils/rds/rds.comments.helper');
const rdsMUsers = require('./bk-utils/rds/rds.marriage.users.helper');

const { MINI_PROFILE_FIELDS, LIMITS_CONFIG, REDIS_CONFIG } = constants;
const { STATUS } = constants.MARRIAGE_CONFIG;

async function savePost(message) {
  logger.info('saving post');
  const { type, userId } = message;
  let user;
  let insertId;
  const postId = await rdsPosts.queryPost(message);
  if (postId) errors.handleError(409, 'post already exists');

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
  await redis.expire(`user_${userId}_timeline`, REDIS_CONFIG.timeline.user);
  logger.info('completed generating timeline for user');
}


async function likeAction(message) {
  const { id, userId, marriageId, postId } = message;
  const [muObj, post, user, like] = await Promise.all([rdsMUsers.getUser(marriageId, userId), rdsPosts.getPost(postId), rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsLikes.getLike(id)]);
  logger.info('requested user ', muObj);
  if (_.isEmpty(muObj) || muObj.status !== STATUS.verified || _.isEmpty(post)) {
    logger.warn('unauthorized like action');
    await rdsLikes.deleteLike(id);
    return;
  }

  await rdsLikes.recountLikes(postId);

  like.user = user;
  await redis.set(`like_${id}`, JSON.stringify(like), REDIS_CONFIG.timeline.likes);
  const key = `${postId}_recent_likes`;
  const ids = await redis.lrange(key, 'int');
  if (!ids.includes(id)) {
    await redis.rpush(key, id);
    const count = await redis.llen(key);
    logger.info('total recent likes ', count);
    if (count > LIMITS_CONFIG.timeline.recent.likes) {
      const res = await redis.lpop(key, 'int');
      logger.info('removed old like ', res);
    }
    await redis.expire(key, REDIS_CONFIG.timeline.likes);
  }
  logger.info('completed like action');
}


async function unlikeAction(message) {
  const { id, postId } = message;
  await rdsLikes.recountLikes(postId);
  await redis.del(`like_${id}`);
  await redis.lrem(`${postId}_recent_likes`, id);
  logger.info('completed unlike action');
}


async function newComment(message) {
  const { id, userId, marriageId, postId } = message;
  const [muObj, post, user, comment] = await Promise.all([rdsMUsers.getUser(marriageId, userId), rdsPosts.getPost(postId), rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsComments.getComment(id)]);
  logger.info('requested user ', muObj);

  if (_.isEmpty(muObj) || muObj.status !== STATUS.verified || _.isEmpty(post)) {
    logger.warn('unauthorized comment action');
    await rdsComments.deleteComment(id);
    return;
  }

  await rdsComments.recountComments(postId);

  comment.user = user;
  await redis.set(`comment_${id}`, JSON.stringify(comment), REDIS_CONFIG.timeline.comments);
  const key = `${postId}_recent_comments`;
  const ids = await redis.lrange(key, 'int');
  if (!ids.includes(id)) {
    await redis.rpush(key, id);
    const count = await redis.llen(key);
    logger.info('total recent comments ', count);
    if (count > LIMITS_CONFIG.timeline.recent.comments) {
      const res = await redis.lpop(key, 'int');
      logger.info('removed old comments ', res);
    }
    await redis.expire(key, REDIS_CONFIG.timeline.comments);
  }
  logger.info('completed comment action');
}


async function editComment(message) {
  const { id, userId, postId } = message;
  const [user, comment] = await Promise.all([rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsComments.getComment(id)]);

  comment.user = user;
  await redis.set(`comment_${id}`, JSON.stringify(comment), REDIS_CONFIG.timeline.comments);
  const key = `${postId}_recent_comments`;
  const ids = await redis.lrange(key, 'int');
  if (!ids.includes(id)) {
    await redis.rpush(key, id);
    const count = await redis.llen(key);
    logger.info('total recent comments ', count);
    if (count > LIMITS_CONFIG.timeline.recent.comments) {
      const res = await redis.lpop(key, 'int');
      logger.info('removed old comments ', res);
    }
    await redis.expire(key, REDIS_CONFIG.timeline.comments);
  }
  logger.info('completed edit comment action');
}


async function deleteComment(message) {
  const { id, postId } = message;
  await rdsComments.recountComments(postId);
  await redis.del(`comment_${id}`);
  await redis.lrem(`${postId}_recent_comments`, id);
  logger.info('completed uncomment action');
}


async function sns(request) {
  logger.info('received timeline event sns');
  logger.info(JSON.stringify(request));
  try {
    const message = JSON.parse(request.Records[0].Sns.Message);
    logger.info(JSON.stringify(message));
    const { action } = message;
    delete message.action;


    let id;
    switch (action) {
      case 'post':
        id = await savePost(message);
        await addToTimelines(id, message);
        break;
      case 'unpost':
        id = await removePost(message);
        await removeFromTimelines(id, message);
        break;
      case 'like': await likeAction(message); break;
      case 'unlike': await unlikeAction(message); break;

      case 'new-comment': await newComment(message); break;
      case 'edit-comment': await editComment(message); break;
      case 'delete-comment': await deleteComment(message); break;
      default:
        logger.warn(`invalid post action ${action}`);
    }
  } catch (err) {
    logger.error(err);
  }
}


module.exports = {
  sns,
  generateTimeline,
};
