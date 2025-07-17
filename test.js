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
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/123/comments",
      (requestBody) => {
        // Verify the confirmation comment
        assert.ok(requestBody.body.includes("✅ Review requests have been sent to:"), "Should contain confirmation message");
        assert.ok(requestBody.body.includes("frontend-dev1"), "Should mention frontend-dev1");
        assert.ok(requestBody.body.includes("frontend-dev2"), "Should mention frontend-dev2");
        assert.ok(requestBody.body.includes("tech-writer"), "Should mention tech-writer");
        assert.ok(requestBody.body.includes("team-lead"), "Should mention team-lead");
        return true;
      }
    )
    .reply(201, {});

  // Mock the review request API call
  const reviewRequestMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/pulls/123/requested_reviewers",
      (requestBody) => {
        // Verify that all unique approvers are requested
        const expectedReviewers = ["frontend-dev1", "frontend-dev2", "tech-writer", "team-lead"];
        assert.ok(Array.isArray(requestBody.reviewers), "Should send reviewers array");
        assert.equal(requestBody.reviewers.length, 4, "Should request 4 unique reviewers");
        expectedReviewers.forEach(reviewer => {
          assert.ok(requestBody.reviewers.includes(reviewer), `Should include ${reviewer}`);
        });
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
  assert.ok(reviewRequestMock.isDone(), "Review request should have been made");
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
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/999/comments",
      (requestBody) => {
        // Verify the confirmation comment for review requests
        assert.ok(requestBody.body.includes("✅ Review requests have been sent to:"), "Should contain confirmation message");
        const expectedApprovers = ["js-developer", "tech-writer", "product-manager", "fallback-reviewer"];
        expectedApprovers.forEach(approver => {
          assert.ok(requestBody.body.includes(approver), `Should mention ${approver} in confirmation`);
        });
        return true;
      }
    )
    .reply(201, {});

  // Mock the review request API call
  const reviewRequestMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/pulls/999/requested_reviewers",
      (requestBody) => {
        const expectedReviewers = ["js-developer", "tech-writer", "product-manager", "fallback-reviewer"];
        assert.ok(Array.isArray(requestBody.reviewers), "Should send reviewers array");
        assert.equal(requestBody.reviewers.length, 4, "Should request 4 unique reviewers");
        expectedReviewers.forEach(reviewer => {
          assert.ok(requestBody.reviewers.includes(reviewer), `Should include ${reviewer}`);
        });
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
  assert.ok(reviewRequestMock.isDone(), "Review request should have been made");
});

test("handles review request failures gracefully", async function () {
  // Set CONFIG_PATH environment variable
  process.env.CONFIG_PATH = ".github/approvers";

  // Mock the config file read
  const configContent = Buffer.from(`
patterns:
  "*.js": "js-dev"
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
    .get("/repos/robandpdx/advanced-codeowners-aws/pulls/555/files")
    .reply(200, [
      { filename: "app.js" }
    ]);

  const commentMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/555/comments",
      (requestBody) => {
        assert.equal(requestBody, { body: "Finding appropriate reviewers for this PR..." });
        return true;
      }
    )
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/555/comments",
      (requestBody) => {
        assert.ok(requestBody.body.includes("## 📋 Approvers Required"), "Should contain approvers header");
        return true;
      }
    )
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/555/comments",
      (requestBody) => {
        // Verify the error comment
        assert.ok(requestBody.body.includes("⚠️ Failed to request reviews"), "Should contain error message");
        assert.ok(requestBody.body.includes("User not found"), "Should contain specific error");
        return true;
      }
    )
    .reply(201, {});

  // Mock the review request API call to fail
  const reviewRequestMock = nock("https://api.github.com")
    .post("/repos/robandpdx/advanced-codeowners-aws/pulls/555/requested_reviewers")
    .reply(422, { message: "User not found" });

  await probot.receive({
    name: "pull_request",
    id: "6",
    payload: {
      action: "review_requested",
      repository: {
        owner: {
          login: "robandpdx",
        },
        name: "advanced-codeowners-aws",
      },
      pull_request: {
        number: 555,
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
  assert.ok(commentMock.isDone(), "Comments should have been posted");
  assert.ok(reviewRequestMock.isDone(), "Review request should have been attempted");
});

test("requestReviewsFromApprovers function handles successful review requests", async function () {
  // This test verifies the requestReviewsFromApprovers function works correctly
  process.env.CONFIG_PATH = ".github/approvers";

  const configContent = Buffer.from(`
patterns:
  "*.js": ["dev1", "dev2"]
  "*.md": ["writer"]
  "*.py": ["dev1"]
`).toString('base64');

  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Ftest-approvers.yaml")
    .query({ ref: "main" })
    .reply(200, {
      content: configContent,
      encoding: "base64"
    });

  const filesMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/pulls/777/files")
    .reply(200, [
      { filename: "file1.js" },
      { filename: "file2.md" },
      { filename: "file3.py" }
    ]);

  // Mock the initial comment, detailed comment, review request, and confirmation comment
  const commentMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/777/comments",
      (requestBody) => {
        console.log("First comment:", requestBody.body);
        return requestBody.body === "Finding appropriate reviewers for this PR...";
      }
    )
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/777/comments",
      (requestBody) => {
        console.log("Second comment:", requestBody.body);
        // This is the detailed approvers comment
        return requestBody.body.includes("## 📋 Approvers Required");
      }
    )
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/777/comments",
      (requestBody) => {
        console.log("Third comment:", requestBody.body);
        // This is the confirmation comment
        return requestBody.body.includes("✅ Review requests have been sent to:");
      }
    )
    .reply(201, {});

  // Mock the review request API call
  const reviewRequestMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/pulls/777/requested_reviewers",
      (requestBody) => {
        const expectedReviewers = ["dev1", "dev2", "writer"];
        assert.ok(Array.isArray(requestBody.reviewers), "Should send reviewers array");
        assert.equal(requestBody.reviewers.length, 3, "Should request 3 unique reviewers");
        expectedReviewers.forEach(reviewer => {
          assert.ok(requestBody.reviewers.includes(reviewer), `Should include ${reviewer}`);
        });
        return true;
      }
    )
    .reply(201, {});

  await probot.receive({
    name: "pull_request",
    id: "7",
    payload: {
      action: "review_requested",
      repository: {
        owner: { login: "robandpdx" },
        name: "advanced-codeowners-aws",
      },
      pull_request: {
        number: 777,
        base: { ref: "main" }
      },
      requested_team: {
        name: "test-approvers",
      },
    },
  });

  // Verify all mocks were called
  assert.ok(configMock.isDone(), "Config file should have been fetched");
  assert.ok(filesMock.isDone(), "PR files should have been fetched");
  assert.ok(reviewRequestMock.isDone(), "Review request should have been made");
  assert.ok(commentMock.isDone(), "All comments should have been posted");
});

test("requestReviewsFromApprovers function handles empty approvers gracefully", async function () {
  // Test with no approvers - should not make any API calls
  process.env.CONFIG_PATH = ".github/approvers";

  const configContent = Buffer.from(`
patterns:
  "*.xyz": ["some-dev"]
# No patterns match our test files
`).toString('base64');

  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Fempty-approvers.yaml")
    .query({ ref: "main" })
    .reply(200, {
      content: configContent,
      encoding: "base64"
    });

  const filesMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/pulls/888/files")
    .reply(200, [
      { filename: "file1.js" },  // No pattern matches
      { filename: "file2.md" }   // No pattern matches
    ]);

  const initialCommentMock = nock("https://api.github.com")
    .post("/repos/robandpdx/advanced-codeowners-aws/issues/888/comments")
    .reply(201, {})
    .post("/repos/robandpdx/advanced-codeowners-aws/issues/888/comments")
    .reply(201, {});

  // No review request or confirmation comment should be made since no approvers

  await probot.receive({
    name: "pull_request",
    id: "8",
    payload: {
      action: "review_requested",
      repository: {
        owner: { login: "robandpdx" },
        name: "advanced-codeowners-aws",
      },
      pull_request: {
        number: 888,
        base: { ref: "main" }
      },
      requested_team: {
        name: "empty-approvers",
      },
    },
  });

  // Verify mocks were called (but no review request should have been made)
  assert.ok(configMock.isDone(), "Config file should have been fetched");
  assert.ok(filesMock.isDone(), "PR files should have been fetched");
  // No additional assertions needed since no review request mocks were set up
});

test.run();
