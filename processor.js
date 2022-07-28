/* eslint-disable no-await-in-loop */
const _ = require('underscore');
const logger = require('./bk-utils/logger');
const errors = require('./bk-utils/errors');
const common = require('./bk-utils/common');
const redis = require('./bk-utils/redis.helper');
const constants = require('./bk-utils/constants');
const snsHelper = require('./bk-utils/sns.helper');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');
const rdsLikes = require('./bk-utils/rds/rds.likes.helper');
const rdsUsers = require('./bk-utils/rds/rds.users.helper');
const rdsComments = require('./bk-utils/rds/rds.comments.helper');
const rdsMUsers = require('./bk-utils/rds/rds.marriage.users.helper');

const { LIMITS_CONFIG, REDIS_CONFIG, APP_NOTIFICATIONS } = constants;
const { STATUS } = constants.MARRIAGE_CONFIG;


function getRecentLikesKey(like) {
  const postfix = 'recent_likes';
  const { parentId, postId, type } = like;
  switch (type) {
    case 'post': return `post_${postId}_${postfix}`;
    case 'comment': return `comment_${parentId}_${postfix}`;
    default: return null;
  }
}

function getRecentCommentsKey(comment) {
  const postfix = 'recent_comments';
  const { parentId, postId, type } = comment;
  switch (type) {
    case 'post': return `post_${postId}_${postfix}`;
    case 'comment': return `comment_${parentId}_${postfix}`;
    default: return null;
  }
}


async function newPost(message) {
  const { postId, marriageId, userId } = message;
  logger.info('adding post to user timelines ', postId, JSON.stringify(message));
  const [mUsers, user, post] = await Promise.all([rdsMUsers.getUsers(marriageId), rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsPosts.getPost(postId)]);
  const ids = mUsers.items.map((u) => u.userId);
  logger.info('total marriage users ', ids.length);
  for (let i = 0; i < ids.length; i += 1) {
    const key = `user_${ids[i]}_timeline`;
    const exists = await redis.exists(key);
    if (exists) {
      await redis.zadd(key, postId, postId);
      // await redis.expire(key, REDIS_CONFIG.timeline.user);
    } else logger.info('skipping timeline update for ', key);
  }
  let title = '';
  logger.info(`post type :: ${post.type}`);
  switch (post.type) {
    case 'marriage.post':
      title = `${user.username ?? user.name} added a new post.`;
      break;
    case 'marriage.join':
      title = `${user.username ?? user.name} joined the marriage.`;
      break;
    default:
  }
  logger.info(`title :: ${title}`);
  await snsHelper.pushToSNS('fcm', { service: 'notification',
    component: 'notification',
    action: 'new',
    data: { id: `${postId}`,
      type: 'default',
      title,
      topic: common.getTopicName('marriage', marriageId),
      groupId: APP_NOTIFICATIONS.channels.profile,
      payload: { screen: '/post-screen', args: { postId, useCache: false } },
    } });
  logger.info('completed adding post to user timelines');
}


async function deletePost(message) {
  const { postId, marriageId } = message;
  let { userIds } = message;
  logger.info('removing post from user timelines ', postId, JSON.stringify(message));

  if (userIds) {
    logger.info('using users from request ', userIds.length);
  } else {
    const mUsers = await rdsMUsers.getUsers(marriageId);
    userIds = mUsers.items.map((user) => user.userId);
    logger.info('total marriage users ', userIds.length);
  }

  for (let i = 0; i < userIds.length; i += 1) {
    const key = `user_${userIds[i]}_timeline`;
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


async function userJoined(message) {
  const { userId, marriageId } = message;
  logger.info('started adding marriage posts to user timeline ', { marriageId, userId });
  const key = `user_${userId}_timeline`;
  const exists = await redis.exists(key);
  if (!exists) {
    logger.info('user timeline does not exist, skipping action');
    return;
  }
  const postIds = await rdsPosts.getMarriagePostIds([marriageId]);
  logger.info('total posts ', postIds.count);
  const tasks = [];
  for (let i = 0; i < postIds.count; i += 1) {
    const id = postIds.items[i];
    tasks.push(redis.zadd(key, id, id));
  }
  await Promise.all(tasks);
  await redis.expire(key, REDIS_CONFIG.timeline.user);
  logger.info('completed adding marriage posts to user timeline');
}


async function userExited(message) {
  const { userId, marriageId } = message;
  logger.info('started removing marriage posts from user timeline ', { marriageId, userId });
  let key = `user_${userId}_timeline`;
  let exists = await redis.exists(key);
  if (!exists) logger.info('user timeline does not exist, skipping action');
  else {
    const postIds = await rdsPosts.getMarriagePostIds([marriageId]);
    logger.info('total marriage posts ', postIds.count);
    await redis.zrem(key, postIds.items);
    logger.info('completed removing marriage posts from user timeline');
  }

  logger.info('started removing user posts from all marriage users');
  const postIds = await rdsPosts.getMarriageUserPostIds(marriageId, userId);
  logger.info('total user posts ', postIds.count);
  await rdsPosts.deletePosts(postIds.items);

  const mUsers = await rdsMUsers.getUsers(marriageId);
  const userIds = mUsers.items.map((user) => user.userId);
  logger.info('total marriage users ', userIds.length);

  for (let k = 0; k < userIds.length; k += 1) {
    key = `user_${userIds[k]}_timeline`;
    exists = await redis.exists(key);
    if (exists) {
      await redis.zrem(key, postIds.items);
    } else logger.info('skipping timeline update for ', key);
  }
  logger.info('completed removing user posts from all marriage users');
}


async function newLike(message) {
  const { id, userId, postId } = message;
  const [post, like, user] = await Promise.all([rdsPosts.getPost(postId), rdsLikes.getLike(id), rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS)]);
  const { marriageId } = post;
  if (marriageId) {
    const muObj = await rdsMUsers.getUser(marriageId, userId);
    logger.info('requested user ', muObj);
    if (_.isEmpty(muObj) || muObj.status !== STATUS.verified || _.isEmpty(post)) {
      logger.warn('unauthorized like action');
      await rdsLikes.deleteLike(id);
      return;
    }
  }
  like.user = user;
  await redis.set(`like_${id}`, JSON.stringify(like), REDIS_CONFIG.timeline.likes);

  await rdsLikes.recountLikes(like.parentId, like.type);

  switch (like.type) {
    case 'post':
      await snsHelper.pushToSNS('fcm', { service: 'notification',
        component: 'notification',
        action: 'new',
        data: {
          id: `${like.id}`,
          type: 'default',
          title: `${user.username ?? user.name} liked your post.`,
          topic: common.getTopicName('user', post.userId),
          groupId: APP_NOTIFICATIONS.channels.post,
          payload: { screen: '/post-screen', args: { postId, useCache: false } },
        } });
      break;
    default:
  }

  const key = getRecentLikesKey(like);
  logger.info('recent likes key ', key);
  if (!key) return;
  logger.info(`saving into recent likes :: ${key}`);
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
  logger.info('completed like actions');
}


async function deleteLike(message) {
  const { id } = message;
  const like = await rdsLikes.getLike(id);
  await Promise.all([rdsLikes.recountLikes(like.parentId, like.type), redis.del(`like_${id}`)]);
  const key = getRecentLikesKey(like);
  if (key) await redis.lrem(key, id);
  logger.info('completed unlike actions');
}


async function newComment(message) {
  const { id, userId, postId } = message;
  const [post, user, comment] = await Promise.all([rdsPosts.getPost(postId), rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsComments.getComment(id)]);
  const { marriageId } = post;
  if (marriageId) {
    const muObj = await rdsMUsers.getUser(marriageId, userId);
    logger.info('requested user ', muObj);
    if (_.isEmpty(muObj) || muObj.status !== STATUS.verified || _.isEmpty(post)) {
      logger.warn('unauthorized comment action');
      await rdsComments.deleteComment(id);
      return;
    }
  }
  comment.user = user;
  await redis.set(`comment_${id}`, JSON.stringify(comment), REDIS_CONFIG.timeline.comments);

  await rdsComments.recountComments(comment.parentId, comment.type);

  switch (comment.type) {
    case 'post':
      await snsHelper.pushToSNS('fcm', { service: 'notification',
        component: 'notification',
        action: 'new',
        data: {
          id: `${comment.id}`,
          type: 'default',
          title: `${user.username ?? user.name} commented on your post.`,
          topic: common.getTopicName('user', post.userId),
          groupId: APP_NOTIFICATIONS.channels.post,
          payload: { screen: '/post-screen', args: { postId, useCache: false } },
        } });
      break;
    default:
  }

  const key = getRecentCommentsKey(comment);
  logger.info('recent comments key ', key);
  if (!key) return;
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
  logger.info('completed comment actions');
}


async function editComment(message) {
  const { id, userId } = message;
  const [user, comment] = await Promise.all([rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsComments.getComment(id)]);

  comment.user = user;
  await redis.set(`comment_${id}`, JSON.stringify(comment), REDIS_CONFIG.timeline.comments);

  const key = getRecentCommentsKey(comment);
  logger.info('recent comments key ', key);
  if (!key) return;
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
  logger.info('completed edit comment actions');
}


async function deleteComment(message) {
  const { id } = message;
  const comment = await rdsComments.getComment(id);
  await Promise.all([rdsComments.recountComments(comment.parentId, comment.type), redis.del(`comment_${id}`)]);
  const key = getRecentCommentsKey(comment);
  if (key) await redis.lrem(key, id);
  logger.info('completed uncomment actions');
}

async function sns(request) {
  logger.info('received timeline processor sns event');
  logger.info(JSON.stringify(request));
  try {
    const message = JSON.parse(request.Records[0].Sns.Message);
    logger.info(JSON.stringify(message));
    const { service, action, component, data } = message;
    if (service !== 'timeline') errors.handleError(400, `invalid service event ${service}, sent for timeline processor`);

    switch (component) {
      case 'like':
        switch (action) {
          case 'add': return newLike(data);
          case 'delete': return deleteLike(data);
          default:
        }
        break;

      case 'comment':
        switch (action) {
          case 'add': return newComment(data);
          case 'edit': return editComment(data);
          case 'delete': return deleteComment(data);
          default:
        }
        break;

      case 'post':
        switch (action) {
          case 'add': return newPost(data);
          case 'delete': return deletePost(data);
          default:
        }
        break;

      case 'marriage':
        switch (action) {
          case 'join': return userJoined(data);
          case 'exit': return userExited(data);
          default:
        }
        break;
      default:
        return errors.handleError(400, `invalid component ${component}`);
    }
    return errors.handleError(400, `invalid component ${component} & action ${action}`);
  } catch (err) {
    logger.error(err);
    return { success: false };
  }
}


module.exports = {
  sns,
  generateTimeline,
};
