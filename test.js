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
    logLevel: "error", // Change to error to reduce noise
    // disable request throttling and retries
    Octokit: ProbotOctokit.defaults({
      throttle: { enabled: false },
      retry: { enabled: false },
    }),
  });
  probot.load(app);
});

test.after.each(() => {
  // Clean up nock after each test
  nock.cleanAll();
  // Clean up environment variables
  delete process.env.CONFIG_PATH;
});

test("receives pull_request.review_requested event when team ending with -approvers is requested", async function () {
  // Set CONFIG_PATH environment variable
  process.env.CONFIG_PATH = ".github/approvers";

  // Mock the config file read
  const configContent = Buffer.from(`
approvers:
  - user1
  - user2
fallback:
  - admin
`).toString('base64');

  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Ffrontend-approvers.yaml")
    .query({ ref: "main" })
    .reply(200, {
      content: configContent,
      encoding: "base64"
    });

  const commentMock = nock("https://api.github.com")
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
        base: {
          ref: "main"
        }
      },
      requested_team: {
        name: "frontend-approvers",
      },
    },
  });

  // Verify all mocks were called
  assert.ok(configMock.isDone(), "Config file should have been fetched");
  assert.ok(commentMock.isDone(), "Comment should have been posted");
});

test("does not comment when team not ending with -approvers is requested", async function () {
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
        base: {
          ref: "main"
        }
      },
      requested_team: {
        name: "frontend",
      },
    },
  });

  // Test passes if no HTTP calls were made (no mock to verify)
});

test("handles config file not found gracefully", async function () {
  // Set CONFIG_PATH environment variable
  process.env.CONFIG_PATH = ".github/approvers";

  // Mock config file not found (404 response)
  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Ffrontend-approvers.yaml")
    .query({ ref: "main" })
    .reply(404, { message: "Not Found" });

  const commentMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/789/comments",
      (requestBody) => {
        assert.equal(requestBody, { body: "Finding appropriate reviewers for this PR..." });
        return true;
      }
    )
    .reply(201, {});

  await probot.receive({
    name: "pull_request",
    id: "4",
    payload: {
      action: "review_requested",
      repository: {
        owner: {
          login: "robandpdx",
        },
        name: "advanced-codeowners-aws",
      },
      pull_request: {
        number: 789,
        base: {
          ref: "main"
        }
      },
      requested_team: {
        name: "frontend-approvers",
      },
    },
  });

  // Verify all mocks were called
  assert.ok(configMock.isDone(), "Config file fetch should have been attempted");
  assert.ok(commentMock.isDone(), "Comment should have been posted despite config error");
});

test.run();
