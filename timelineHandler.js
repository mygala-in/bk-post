const logger = require('./bk-utils/logger');

async function invoke(request) {
  logger.info('received timeline event');
  logger.info(JSON.stringify(request));
  try {
    const message = JSON.parse(request.Records[0].Sns.Message);
    logger.info(message);
    const { type } = message;
    switch (type) {
      case 'marriage.join':
        break;
      case 'marriage.remove':
        break;
      default:
    }
  } catch (err) {
    logger.error(err);
  }
}

module.exports = {
  invoke,
};
