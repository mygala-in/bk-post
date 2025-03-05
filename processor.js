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
const rdsOccasions = require('./bk-utils/rds/rds.occasions.helper');
const rdsOUsers = require('./bk-utils/rds/rds.occasion.users.helper');
const rdsWEvents = require('./bk-utils/rds/rds.wedding.events.helper');

const { LIMITS_CONFIG, REDIS_CONFIG, APP_NOTIFICATIONS, OCCASION_CONFIG } = constants;


function getRecentLikesKey(like) {
  const { resource, entityId } = common.getEntityResource(like.parentId);
  return `{${resource}}_${entityId}_recent_likes`;
}

function getRecentCommentsKey(comment) {
  const { resource, entityId } = common.getEntityResource(comment.parentId);
  return `{${resource}}_${entityId}_recent_comments`;
}


async function getRootParent(parentId) {
  const { entityId, resource } = common.getEntityResource(parentId);

  let parent;
  switch (resource) {
    case 'post':
      return rdsPosts.getPost(entityId);
    case 'occasion':
      return rdsOccasions.getOccasion(entityId);
    case 'event':
      return rdsWEvents.getEventById(entityId);
    case 'comment':
      parent = await rdsComments.getComment(entityId);
      logger.info('sub parent ', parent);
      return getRootParent(parent.parentId);
    default:
      return null;
  }
}


async function newPost(message) {
  const { userId, parentId, type, status } = message;
  const { entityId } = common.getEntityResource(parentId);

  logger.info('creating new post ', JSON.stringify(message));
  const { insertId } = await rdsPosts.insertPost({ userId, parentId, type, status });

  logger.info('adding post to occasion timeline ', insertId);
  const wtl = redis.transformKey(`occasion_${entityId}_posts`);
  if (await redis.exists(wtl)) {
    await redis.zadd(wtl, insertId, insertId);
  } else logger.info('skipping occasion timeline update for ', wtl);

  logger.info('adding post to user timelines ', insertId, JSON.stringify(message));
  const [mUsers, user, post] = await Promise.all([rdsOUsers.getUsers(entityId), rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsPosts.getPost(insertId)]);
  const ids = mUsers.items.map((u) => u.userId);
  logger.info('total occasion users ', ids.length);
  for (let i = 0; i < ids.length; i += 1) {
    const utl = redis.transformKey(`user_${ids[i]}_posts`);
    if (await redis.exists(utl)) {
      await redis.zadd(utl, insertId, insertId);
    } else logger.info('skipping user timeline update for ', utl);
  }
  let title = '';
  logger.info(`post type :: ${post.type}`);
  switch (post.type) {
    case 'image':
      title = `${user.username ?? user.name} added a new post.`;
      break;
    case 'join':
      title = `${user.username ?? user.name} joined the occasion.`;
      break;
    default:
  }
  logger.info(`title :: ${title}`);
  await snsHelper.pushToSNS('fcm', {
    service: 'notification',
    component: 'notification',
    action: 'new',
    data: {
      id: `${insertId}`,
      type: 'default',
      title,
      topic: common.getTopicName('occasion', entityId),
      groupId: APP_NOTIFICATIONS.channels.profile,
      payload: { screen: `/posts/${insertId}`, params: { useCache: 'false' } },
    },
  });
  logger.info('completed adding post to user & occasion timelines');
}


async function deletePost(message) {
  const { postId, parentId } = message;
  let { userIds } = message;

  logger.info('deleting post ', postId);
  const key = redis.transformKey(`post_${postId}`);
  await Promise.all([
    rdsPosts.deletePost(postId),
    redis.del(redis.transformKey(`${key}_likes_count`)),
    redis.del(redis.transformKey(`${key}_comments_count`)),
  ]);

  const { entityId } = common.getEntityResource(parentId);
  logger.info('removing post from user & occasion timelines ', postId, JSON.stringify(message));

  const wtl = redis.transformKey(`occasion_${entityId}_posts`);
  if (await redis.exists(wtl)) {
    await redis.zrem(wtl, postId);
  }

  if (userIds) {
    logger.info('using users from request ', userIds.length);
  } else {
    const mUsers = await rdsOUsers.getUsers(entityId);
    userIds = mUsers.items.map((user) => user.userId);
    logger.info('total occasion users ', userIds.length);
  }

  for (let i = 0; i < userIds.length; i += 1) {
    const utl = redis.transformKey(`user_${userIds[i]}_posts`);
    if (await redis.exists(utl)) {
      await redis.zrem(utl, postId);
    } else logger.info('skipping timeline update for ', utl);
  }
  logger.info('completed removing post from user timelines');
}


async function generateUserTimeline(userId) {
  logger.info('started generating timeline for user ', userId);
  const mJoins = await rdsOUsers.getOccasions(userId);
  const vIds = mJoins.items.filter((i) => i.status === OCCASION_CONFIG.status.verified).map((i) => `${i.type}_${i.occasionId}`);
  logger.info('verified occasion ids ', vIds);

  const key = redis.transformKey(`user_${userId}_posts`);
  const postIds = await rdsPosts.getParentPostIds(vIds);
  logger.info('total posts ', postIds.count);
  const tasks = [];
  for (let i = 0; i < postIds.count; i += 1) {
    const id = postIds.items[i];
    tasks.push(redis.zadd(key, id, id));
  }
  await Promise.all(tasks);
  await redis.expire(key, REDIS_CONFIG.timeline.user);
  logger.info('completed generating timeline for user');
}


async function generateOccasionTimeline(occasionId) {
  logger.info('started generating timeline for occasion ', occasionId);
  const postIds = await rdsPosts.getParentPostIds([occasionId]);
  logger.info('total posts ', postIds.count);
  const tasks = [];
  const key = redis.transformKey(`occasion_${occasionId}_posts`);
  for (let i = 0; i < postIds.count; i += 1) {
    const id = postIds.items[i];
    tasks.push(redis.zadd(key, id, id));
  }
  await Promise.all(tasks);
  await redis.expire(key, REDIS_CONFIG.timeline.occasion);
  logger.info('completed generating timeline for occasion');
}


async function userJoined(message) {
  const { userId, occasionId } = message;
  logger.info('started adding occasion posts to user timeline ', { occasionId, userId });
  const key = redis.transformKey(`user_${userId}_posts`);
  const exists = await redis.exists(key);
  if (!exists) {
    logger.info('user timeline does not exist, skipping action');
    return;
  }
  const postIds = await rdsPosts.getParentPostIds([occasionId]);
  logger.info('total posts ', postIds.count);
  const tasks = [];
  for (let i = 0; i < postIds.count; i += 1) {
    const id = postIds.items[i];
    tasks.push(redis.zadd(key, id, id));
  }
  await Promise.all(tasks);
  await redis.expire(key, REDIS_CONFIG.timeline.user);
  logger.info('completed adding occasion posts to user timeline');
}


async function userExited(message) {
  const { userId, occasionId } = message;
  logger.info('started removing occasion posts from user timeline ', { occasionId, userId });
  let key = redis.transformKey(`user_${userId}_posts`);
  let exists = await redis.exists(key);
  if (!exists) logger.info('user timeline does not exist, skipping action');
  else {
    const postIds = await rdsPosts.getParentPostIds([occasionId]);
    logger.info('total occasion posts ', postIds.count);
    await redis.zrem(key, postIds.items);
    logger.info('completed removing occasion posts from user timeline');
  }

  logger.info('started removing user posts from all occasion users');
  const postIds = await rdsPosts.getParentUserPostIds(occasionId, userId);
  logger.info('total user posts ', postIds.count);
  await rdsPosts.deletePosts(postIds.items);

  const mUsers = await rdsOUsers.getUsers(occasionId);
  const userIds = mUsers.items.map((user) => user.userId);
  logger.info('total occasion users ', userIds.length);

  for (let k = 0; k < userIds.length; k += 1) {
    key = redis.transformKey(`user_${userIds[k]}_posts`);
    exists = await redis.exists(key);
    if (exists) {
      await redis.zrem(key, postIds.items);
    } else logger.info('skipping timeline update for ', key);
  }
  logger.info('completed removing user posts from all occasion users');
}


async function newLike(message) {
  const { id, userId, parentId } = message;
  const { entityId, resource } = common.getEntityResource(parentId);

  const [parent, like, user] = await Promise.all([getRootParent(parentId), rdsLikes.getLike(id), rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS)]);
  logger.info('root parent ', JSON.stringify(parent));

  let topic = '';
  if (parent && parent.entity) {
    let muObj;
    switch (parent.entity) {
      case 'post':
        if (_.has(parent, 'parentId')) {
          const occasionId = common.getEntityResource(parent.parentId).entityId;
          muObj = await rdsOUsers.getUser(occasionId, userId);
          logger.info('requested user ', muObj);
          if (_.isEmpty(muObj) || muObj.status !== OCCASION_CONFIG.status.verified || _.isEmpty(parent)) {
            logger.warn('unauthorized like action');
            await rdsLikes.deleteLike(id);
            return;
          }
        }
        topic = common.getTopicName('user', parent.userId);
        break;

      default:
        logger.warn('unhandled parent liked');
        await rdsLikes.deleteLike(id);
        return;
    }
  }

  like.user = user;
  await redis.set(`like_${id}`, JSON.stringify(like), REDIS_CONFIG.timeline.likes);
  await rdsLikes.recountLikes(like.parentId);

  switch (resource) {
    case 'post':
      await snsHelper.pushToSNS('fcm', {
        service: 'notification',
        component: 'notification',
        action: 'new',
        data: {
          id: `${like.id}`,
          type: 'default',
          title: `${user.username ?? user.name} liked your post.`,
          topic,
          groupId: APP_NOTIFICATIONS.channels.post,
          payload: { screen: `/posts/${entityId}`, params: { useCache: 'false' } },
        },
      });
      break;

    case 'comment':
      await snsHelper.pushToSNS('fcm', {
        service: 'notification',
        component: 'notification',
        action: 'new',
        data: {
          id: `${like.id}`,
          type: 'default',
          title: `${user.username ?? user.name} liked your comment.`,
          topic,
          groupId: APP_NOTIFICATIONS.channels.post,
          payload: { screen: `/posts/${entityId}`, params: { useCache: 'false' } },
        },
      });
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
  await Promise.all([rdsLikes.recountLikes(like.parentId), redis.del(`like_${id}`)]);
  const key = getRecentLikesKey(like);
  if (key) await redis.lrem(key, id);
  logger.info('completed unlike actions');
}


async function newComment(message) {
  const { id, userId, parentId } = message;
  const [resource, ...entityIdx] = parentId.split('_');
  const entityId = entityIdx.join('_');
  const [post, user, comment] = await Promise.all([rdsPosts.getPost(entityId), rdsUsers.getUserFields(userId, constants.MINI_PROFILE_FIELDS), rdsComments.getComment(id)]);
  logger.info('parent post ', JSON.stringify(post));

  if (_.has(post, 'parentId')) {
    const occasionId = common.getEntityResource(post.parentId).entityId;
    const muObj = await rdsOUsers.getUser(occasionId, userId);
    logger.info('requested user ', muObj);
    if (_.isEmpty(muObj) || muObj.status !== OCCASION_CONFIG.status.verified || _.isEmpty(post)) {
      logger.warn('unauthorized comment action');
      await rdsComments.deleteComment(id);
      return;
    }
  }
  comment.user = user;
  await redis.set(redis.transformKey(`comment_${id}`), JSON.stringify(comment), REDIS_CONFIG.timeline.comments);

  await rdsComments.recountComments(comment.parentId);
  switch (resource) {
    case 'post':
      await snsHelper.pushToSNS('fcm', {
        service: 'notification',
        component: 'notification',
        action: 'new',
        data: {
          id: `${comment.id}`,
          type: 'default',
          title: `${user.username ?? user.name} commented on your post.`,
          topic: common.getTopicName('user', post.userId),
          groupId: APP_NOTIFICATIONS.channels.post,
          payload: { screen: `/posts/${entityId}`, params: { useCache: 'false' } },
        },
      });
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
  await redis.set(redis.transformKey(`comment_${id}`), JSON.stringify(comment), REDIS_CONFIG.timeline.comments);

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
  await Promise.all([rdsComments.recountComments(comment.parentId), redis.del(redis.transformKey(`comment_${id}`))]);
  const key = getRecentCommentsKey(comment);
  if (key) await redis.lrem(key, id);
  logger.info('completed uncomment actions');
}

async function sns(request) {
  logger.info('received post processor sns event');
  logger.info(JSON.stringify(request));
  try {
    const message = JSON.parse(request.Records[0].Sns.Message);
    logger.info(JSON.stringify(message));
    const { service, action, component, data } = message;
    if (service !== 'post') errors.handleError(400, `invalid service event ${service}, sent for post processor`);

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

      case 'occasion':
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
  generateUserTimeline,
  generateOccasionTimeline,
};
