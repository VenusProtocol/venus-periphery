const assert = require("node:assert/strict");
const test = require("node:test");
const { CookieStorage } = require("amazon-cognito-identity-js");

test("Cognito CookieStorage can write and read with the resolved js-cookie version", () => {
  const previousDocument = global.document;
  global.document = { cookie: "" };

  try {
    const storage = new CookieStorage({ domain: "localhost", secure: false });
    assert.equal(storage.setItem("dependency-check", "ok"), "ok");
    assert.equal(storage.getItem("dependency-check"), "ok");
  } finally {
    if (previousDocument === undefined) {
      delete global.document;
    } else {
      global.document = previousDocument;
    }
  }
});
