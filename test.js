const { suite } = require("uvu");
const assert = require("uvu/assert");

const nock = require("nock");
nock.disableNetConnect();

const {
  Probot,
  ProbotOctokit,
} = require("@probot/adapter-aws-lambda-serverless");

const app = require("./app");

/** @type {import('probot').Probot */
let probot;
const test = suite("app");
test.before.each(() => {
  probot = new Probot({
    // simple authentication as alternative to appId/privateKey
    githubToken: "test",
    // disable logs
    logLevel: "warn",
    // disable request throttling and retries
    Octokit: ProbotOctokit.defaults({
      throttle: { enabled: false },
      retry: { enabled: false },
    }),
  });
  probot.load(app);
});

test("receives pull_request.review_requested event when bot is requested", async function () {
  // Set the BOT_USERNAME environment variable for this test
  process.env.BOT_USERNAME = "robandpdx_volcano";
  
  const mock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/123/comments",
      (requestBody) => {
        assert.equal(requestBody, { body: "Finding appropriate reviewers for this PR..." });
        return true;
      }
    )
    .reply(201, {});

  await probot.receive({
    name: "pull_request",
    id: "2",
    payload: {
      action: "review_requested",
      repository: {
        owner: {
          login: "robandpdx",
        },
        name: "advanced-codeowners-aws",
      },
      pull_request: {
        number: 123,
      },
      requested_reviewer: {
        login: "robandpdx_volcano",
      },
    },
  });

  assert.equal(mock.activeMocks(), []);
});

test("does not comment when different user is requested as reviewer", async function () {
  // Set the BOT_USERNAME environment variable for this test
  process.env.BOT_USERNAME = "robandpdx_volcano";
  
  // No mock needed since no API call should be made
  
  await probot.receive({
    name: "pull_request",
    id: "3",
    payload: {
      action: "review_requested",
      repository: {
        owner: {
          login: "robandpdx",
        },
        name: "advanced-codeowners-aws",
      },
      pull_request: {
        number: 456,
      },
      requested_reviewer: {
        login: "different-user",
      },
    },
  });

  // Test passes if no HTTP calls were made (no mock to verify)
});

test.run();
