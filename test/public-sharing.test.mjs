import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const app = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
const sharedTrial = app.slice(app.indexOf("function openSharedTrial()"), app.indexOf("async function checkOpera()"));

function runTrial(trial) {
  const elements = {
    operatorProfileUrl: { value: "https://www.instagram.com/my_profile/" },
    profileUrl: { value: "" },
    offer: { value: "ピラティス" }
  };
  const saved = [];
  runInNewContext(`${sharedTrial}\nopenSharedTrial();`, {
    URL,
    window: {
      location: { href: `https://example.test/?trial=${encodeURIComponent(trial)}` },
      setTimeout() {}
    },
    form: { elements },
    clearInstagramContext() {},
    saveInstagramUrl(input) { saved.push(input); },
    updateOtherOffer() {},
    setNotice() {}
  });
  return { elements, saved };
}

test("shared trials change only the counterpart and keep the user's own account", () => {
  const { elements, saved } = runTrial("another_person");
  assert.equal(elements.profileUrl.value, "https://www.instagram.com/another_person/");
  assert.equal(elements.operatorProfileUrl.value, "https://www.instagram.com/my_profile/");
  assert.equal(elements.offer.value, "auto");
  assert.deepEqual(saved, [elements.profileUrl]);
});

test("invalid shared trial names do not change or save either account", () => {
  const { elements, saved } = runTrial("not/an/account");
  assert.equal(elements.profileUrl.value, "");
  assert.equal(elements.operatorProfileUrl.value, "https://www.instagram.com/my_profile/");
  assert.equal(elements.offer.value, "ピラティス");
  assert.deepEqual(saved, []);
});
