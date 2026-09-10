"use strict";

/** Run a normal-runtime initializer at most once, including after a failure. */
function createOnceRunner(start) {
  let state = "not-started";
  let result;
  let error = null;

  return {
    get state() { return state; },
    get error() { return error; },
    start() {
      if (state !== "not-started") return { started: false, state, result, error };
      state = "starting";
      try {
        result = start();
        state = "started";
        return { started: true, state, result, error: null };
      } catch (e) {
        error = e;
        state = "failed";
        throw e;
      }
    }
  };
}

module.exports = { createOnceRunner };
