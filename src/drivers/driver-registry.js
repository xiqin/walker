'use strict';

class DriverRegistry {
  constructor() {
    this.drivers = {};
  }

  register(name, driver) {
    this.drivers[name] = driver;
  }

  get(name) {
    return this.drivers[name] || null;
  }

  list() {
    return Object.keys(this.drivers);
  }
}

module.exports = { DriverRegistry };
