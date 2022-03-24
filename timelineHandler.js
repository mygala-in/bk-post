const logger = require('./bk-utils/logger');
const constants = require('./bk-utils/constants');
const rdsPosts = require('./bk-utils/rds/rds.posts.helper');
const rdsUsers = require('./bk-utils/rds/rds.users.helper');

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
}


async function invoke(request) {
  logger.info('received timeline event');
  logger.info(JSON.stringify(request));
  try {
    const message = JSON.parse(request.Records[0].Sns.Message);
    logger.info(message);
    await savePost(message);
  } catch (err) {
    logger.error(err);
  }
}

module.exports = {
  invoke,
};
