const { JsonStore } = require('./json-store');

class SessionStore {
  constructor(dataDir) {
    this.sessions = new JsonStore(
      require('path').join(dataDir, 'sessions.json'),
      {}
    );
    this.routes = new JsonStore(
      require('path').join(dataDir, 'routes.json'),
      {}
    );
  }
}

module.exports = { SessionStore };
