const logger = require('./bk-utils/logger');

async function invoke(request) {
  logger.info('received timeline event');
  logger.info(JSON.stringify(request));
}

module.exports = {
  invoke,
};
