const { createHeartbeatRegistry } = require('./scheduler');
module.exports = { ...createHeartbeatRegistry(), createHeartbeatRegistry };
