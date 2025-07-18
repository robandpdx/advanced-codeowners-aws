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

const configContent = Buffer.from(`
patterns:
  - pattern: "backend/**/*.pdf"
    team-owners:
    - "pfd-team"
  - pattern: "backend/**/*"
    owners:
    - "tclifton_volcano"
    team-owners:
    - "backend-team"
  - pattern: "frontend/**/*.pdf"
    team-owners:
    - "pdf-team"
  - pattern: "frontend/**/*.md"
    owners:
    - "tclifton_volcano"
    team-owners:
    - "markdown-team"
  - pattern: "frontend/**/*"
    owners:
    - "tclifton_volcano"
    team-owners:
    - "frontend-team"
`).toString('base64');

test("receives pull_request.review_requested event when team ending with -approvers is requested", async function () {
  // Set CONFIG_PATH environment variable
  process.env.CONFIG_PATH = ".github/approvers";

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
      { filename: "backend/report.pdf" },
      { filename: "frontend/docs.md" },
      { filename: "frontend/app.js" }
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
        assert.ok(requestBody.body.includes("tclifton_volcano"), "Should contain tclifton_volcano");
        assert.ok(requestBody.body.includes("pfd-team"), "Should contain pfd-team");
        assert.ok(requestBody.body.includes("markdown-team"), "Should contain markdown-team");
        assert.ok(requestBody.body.includes("frontend-team"), "Should contain frontend-team");
        return true;
      }
    )
    .reply(201, {})
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/123/comments",
      (requestBody) => {
        // Verify the confirmation comment
        assert.ok(requestBody.body.includes("✅ Review requests have been sent to:"), "Should contain confirmation message");
        assert.ok(requestBody.body.includes("tclifton_volcano"), "Should mention tclifton_volcano");
        assert.ok(requestBody.body.includes("pfd-team"), "Should mention pfd-team");
        assert.ok(requestBody.body.includes("markdown-team"), "Should mention markdown-team");
        assert.ok(requestBody.body.includes("frontend-team"), "Should mention frontend-team");
        return true;
      }
    )
    .reply(201, {});

  // Mock the review request API call
  const reviewRequestMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/pulls/123/requested_reviewers",
      (requestBody) => {
        // Verify that individual reviewers are requested
        assert.ok(Array.isArray(requestBody.reviewers), "Should send reviewers array");
        assert.ok(requestBody.reviewers.includes("tclifton_volcano"), "Should include tclifton_volcano");
        
        // Verify that team reviewers are requested
        assert.ok(Array.isArray(requestBody.team_reviewers), "Should send team_reviewers array");
        const expectedTeams = ["pfd-team", "markdown-team", "frontend-team"];
        expectedTeams.forEach(team => {
          assert.ok(requestBody.team_reviewers.includes(team), `Should include ${team}`);
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
      { filename: "backend/report.pdf" },      // matches backend pdf pattern -> pfd-team
      { filename: "frontend/docs.md" },        // matches frontend md pattern -> tclifton_volcano, markdown-team
      { filename: "frontend/app.js" }          // matches frontend pattern -> tclifton_volcano, frontend-team
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
        assert.ok(body.includes("tclifton_volcano"), "Should show tclifton_volcano");
        assert.ok(body.includes("pfd-team"), "Should show pfd-team");
        assert.ok(body.includes("markdown-team"), "Should show markdown-team");
        assert.ok(body.includes("frontend-team"), "Should show frontend-team");
        assert.ok(body.includes("backend/report.pdf"), "Should list pdf file");
        assert.ok(body.includes("frontend/docs.md"), "Should list md file");
        assert.ok(body.includes("frontend/app.js"), "Should list js file");
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
        assert.ok(requestBody.body.includes("tclifton_volcano"), "Should mention tclifton_volcano");
        assert.ok(requestBody.body.includes("pfd-team"), "Should mention pfd-team");
        assert.ok(requestBody.body.includes("markdown-team"), "Should mention markdown-team");
        assert.ok(requestBody.body.includes("frontend-team"), "Should mention frontend-team");
        return true;
      }
    )
    .reply(201, {});

  // Mock the review request API call
  const reviewRequestMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/pulls/999/requested_reviewers",
      (requestBody) => {
        assert.ok(Array.isArray(requestBody.reviewers), "Should send reviewers array");
        assert.ok(requestBody.reviewers.includes("tclifton_volcano"), "Should include tclifton_volcano");
        
        assert.ok(Array.isArray(requestBody.team_reviewers), "Should send team_reviewers array");
        const expectedTeams = ["pfd-team", "markdown-team", "frontend-team"];
        expectedTeams.forEach(team => {
          assert.ok(requestBody.team_reviewers.includes(team), `Should include ${team}`);
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
      { filename: "backend/report.pdf" }
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
        assert.ok(requestBody.body.includes("Team not found"), "Should contain specific error");
        return true;
      }
    )
    .reply(201, {});

  // Mock the review request API call to fail
  const reviewRequestMock = nock("https://api.github.com")
    .post("/repos/robandpdx/advanced-codeowners-aws/pulls/555/requested_reviewers")
    .reply(422, { message: "Team not found" });

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
      { filename: "backend/report.pdf" },
      { filename: "frontend/docs.md" },
      { filename: "frontend/app.js" }
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
        assert.ok(Array.isArray(requestBody.reviewers), "Should send reviewers array");
        assert.ok(requestBody.reviewers.includes("tclifton_volcano"), "Should include tclifton_volcano");
        
        assert.ok(Array.isArray(requestBody.team_reviewers), "Should send team_reviewers array");
        const expectedTeams = ["pfd-team", "markdown-team", "frontend-team"];
        expectedTeams.forEach(team => {
          assert.ok(requestBody.team_reviewers.includes(team), `Should include ${team}`);
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

  // Create a config that won't match any files
  const emptyConfigContent = Buffer.from(`
patterns:
  - pattern: "*.xyz"
    owners:
    - "some-dev"
# No patterns match our test files
`).toString('base64');

  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Fempty-approvers.yaml")
    .query({ ref: "main" })
    .reply(200, {
      content: emptyConfigContent,
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

test("handles pull_request_review.submitted event for approved reviews", async function () {
  // Set CONFIG_PATH environment variable
  process.env.CONFIG_PATH = ".github/approvers";

  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Ffrontend-approvers.yaml")
    .query({ ref: "main" })
    .reply(200, {
      content: configContent,
      encoding: "base64"
    });

  // Mock the PR files list
  const filesMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/pulls/456/files")
    .reply(200, [
      { filename: "frontend/app.js" },
      { filename: "backend/report.pdf" }
    ]);

  // Mock team membership check
  const teamMembershipMock = nock("https://api.github.com")
    .get("/orgs/robandpdx/teams/frontend-team/memberships/tclifton_volcano")
    .reply(200, { state: "active" })
    .get("/orgs/robandpdx/teams/pfd-team/memberships/tclifton_volcano")
    .reply(404, { message: "Not Found" })
    .get("/orgs/robandpdx/teams/backend-team/memberships/tclifton_volcano")
    .reply(404, { message: "Not Found" });

  // Mock the comment that should be posted
  const commentMock = nock("https://api.github.com")
    .post(
      "/repos/robandpdx/advanced-codeowners-aws/issues/456/comments",
      (requestBody) => {
        assert.ok(requestBody.body.includes("## ✅ Review Approval Received"), "Should contain approval header");
        assert.ok(requestBody.body.includes("@tclifton_volcano"), "Should mention the reviewer");
        assert.ok(requestBody.body.includes("Review requests satisfied by this approval"), "Should show satisfied review requests");
        assert.ok(requestBody.body.includes("Individual owner: @tclifton_volcano"), "Should show individual owner status");
        assert.ok(requestBody.body.includes("Team owner: @frontend-team"), "Should show team owner");
        return true;
      }
    )
    .reply(201, {});

  await probot.receive({
    name: "pull_request_review",
    id: "9",
    payload: {
      action: "submitted",
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
        },
        requested_teams: [
          {
            name: "frontend-approvers"
          }
        ]
      },
      review: {
        state: "approved",
        user: {
          login: "tclifton_volcano"
        }
      }
    },
  });

  // Verify all mocks were called
  assert.ok(configMock.isDone(), "Config file should have been checked");
  assert.ok(filesMock.isDone(), "PR files should have been fetched");
  assert.ok(teamMembershipMock.isDone(), "Team memberships should have been checked");
  assert.ok(commentMock.isDone(), "Approval comment should have been posted");
});

test("ignores pull_request_review.submitted event for non-approved reviews", async function () {
  // No mocks needed since no API calls should be made
  
  await probot.receive({
    name: "pull_request_review",
    id: "10",
    payload: {
      action: "submitted",
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
      review: {
        state: "changes_requested",
        user: {
          login: "some_reviewer"
        }
      }
    },
  });

  // Test passes if no HTTP calls were made (no mock to verify)
});

test("handles pull_request_review.submitted when reviewer doesn't satisfy any requirements", async function () {
  // Set CONFIG_PATH environment variable
  process.env.CONFIG_PATH = ".github/approvers";

  const configMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/contents/.github%2Fapprovers%2Ffrontend-approvers.yaml")
    .query({ ref: "main" })
    .reply(200, {
      content: configContent,
      encoding: "base64"
    });

  // Mock the PR files list
  const filesMock = nock("https://api.github.com")
    .get("/repos/robandpdx/advanced-codeowners-aws/pulls/999/files")
    .reply(200, [
      { filename: "frontend/app.js" }
    ]);

  // Mock team membership check - user is not a member of any teams
  const teamMembershipMock = nock("https://api.github.com")
    .get("/orgs/robandpdx/teams/frontend-team/memberships/random_user")
    .reply(404, { message: "Not Found" });

  // No comment should be posted since the user doesn't satisfy any requirements

  await probot.receive({
    name: "pull_request_review",
    id: "11",
    payload: {
      action: "submitted",
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
        },
        requested_teams: [
          {
            name: "frontend-approvers"
          }
        ]
      },
      review: {
        state: "approved",
        user: {
          login: "random_user"
        }
      }
    },
  });

  // Verify mocks were called but no comment was posted
  assert.ok(configMock.isDone(), "Config file should have been checked");
  assert.ok(filesMock.isDone(), "PR files should have been fetched");
  assert.ok(teamMembershipMock.isDone(), "Team membership should have been checked");
});

test.run();
