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
patterns:
  "src/**/*.js":
    - "frontend-dev1"
    - "frontend-dev2"
  "docs/**": "tech-writer"
  "*.md": "product-manager"
fallback:
  - "team-lead"
`).toString('base64');

  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Ffrontend-approvers.yaml")
    .query({ ref: "main" })
    .reply(200, {
      content: configContent,
      encoding: "base64"
    });

  // Mock the PR files list
  const filesMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/pulls/123/files")
    .reply(200, [
      { filename: "src/components/Button.js" },
      { filename: "docs/README.md" },
      { filename: "package.json" }
    ]);

  const commentMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/123/comments",
      (requestBody) => {
        assert.equal(requestBody, { body: "Finding appropriate reviewers for this PR..." });
        return true;
      }
    )
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/123/comments",
      (requestBody) => {
        // Verify the detailed comment contains expected elements
        assert.ok(requestBody.body.includes("## 📋 Approvers Required"), "Should contain approvers header");
        assert.ok(requestBody.body.includes("frontend-dev1"), "Should contain frontend-dev1");
        assert.ok(requestBody.body.includes("tech-writer"), "Should contain tech-writer");
        assert.ok(requestBody.body.includes("src/components/Button.js"), "Should contain JS file");
        assert.ok(requestBody.body.includes("docs/README.md"), "Should contain docs file");
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
  assert.ok(filesMock.isDone(), "PR files should have been fetched");
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
        assert.equal(requestBody, { body: "No approvers configuration found at `.github/approvers/frontend-approvers.yaml`. Please check the file path and try again." });
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

test("comment generation handles various file scenarios", async function () {
  // Set CONFIG_PATH environment variable
  process.env.CONFIG_PATH = ".github/approvers";

  // Create config with different scenarios
  const configContent = Buffer.from(`
patterns:
  "src/**/*.js": "js-developer"
  "docs/**": 
    - "tech-writer"
    - "product-manager"
fallback:
  - "fallback-reviewer"
`).toString('base64');

  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Ffrontend-approvers.yaml")
    .query({ ref: "main" })
    .reply(200, {
      content: configContent,
      encoding: "base64"
    });

  // Mock PR files with various scenarios
  const filesMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/pulls/999/files")
    .reply(200, [
      { filename: "src/app.js" },          // matches js pattern -> js-developer
      { filename: "docs/README.md" },      // matches docs pattern -> tech-writer, product-manager
      { filename: "package.json" }         // no match -> fallback-reviewer
    ]);

  const commentMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/999/comments",
      (requestBody) => {
        assert.equal(requestBody, { body: "Finding appropriate reviewers for this PR..." });
        return true;
      }
    )
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/999/comments",
      (requestBody) => {
        const body = requestBody.body;
        // Verify comment structure
        assert.ok(body.includes("## 📋 Approvers Required"), "Should contain header");
        assert.ok(body.includes("👥 Approvers: js-developer"), "Should show js-developer");
        assert.ok(body.includes("👥 Approvers: product-manager, tech-writer"), "Should show docs approvers");
        assert.ok(body.includes("👥 Approvers: fallback-reviewer"), "Should show fallback");
        assert.ok(body.includes("src/app.js"), "Should list js file");
        assert.ok(body.includes("docs/README.md"), "Should list docs file");
        assert.ok(body.includes("package.json"), "Should list fallback file");
        assert.ok(body.includes("**Summary:**"), "Should contain summary");
        return true;
      }
    )
    .reply(201, {});

  await probot.receive({
    name: "pull_request",
    id: "5",
    payload: {
      action: "review_requested",
      repository: {
        owner: {
          login: "robandpdx",
        },
        name: "advanced-codeowners-aws",
      },
      pull_request: {
        number: 999,
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
  assert.ok(filesMock.isDone(), "PR files should have been fetched");
  assert.ok(commentMock.isDone(), "Comment should have been posted");
});

test.run();
