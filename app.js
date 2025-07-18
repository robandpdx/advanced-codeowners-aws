/**
 * @param {import('probot').Probot} app
 */
module.exports = (app) => {
  console.log("Yay! The app was loaded!");

  // Require yaml at the top level
  const yaml = require('js-yaml');

  /**
   * Read approvers configuration from a YAML file in the repository
   * @param {string} configPath - Path to the config file
   * @param {object} context - Probot context object
   * @returns {Promise<object|null>} - Parsed YAML config or null if not found
   */
  async function readApproversConfig(configPath, context) {
    try {
      const { pull_request } = context.payload;
      const { owner, repo } = context.repo();
      
      // Get the file content from the base branch of the PR
      const response = await context.octokit.repos.getContent({
        owner,
        repo,
        path: configPath,
        ref: pull_request.base.ref
      });

      // Decode the base64 content
      const content = Buffer.from(response.data.content, 'base64').toString('utf8');
      
      // Parse YAML
      return yaml.load(content);
      
    } catch (error) {
      console.error(`Failed to read config file ${configPath}:`, error.message);
      return null;
    }
  }

  /**
   * Find appropriate approvers for files in the pull request
   * @param {object} context - Probot context object
   * @param {object} pull_request - Pull request object
   * @param {object} approversConfig - Approvers configuration object
   * @returns {Promise<{fileApproverMap: Map<string, string[]>, fileTeamApproverMap: Map<string, string[]>}>} - Maps of file paths to arrays of approvers and team approvers
   */
  async function findApprovers(context, pull_request, approversConfig) {
    const { minimatch } = require('minimatch');
    
    const files = await context.octokit.pulls.listFiles({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      pull_number: pull_request.number
    });

    const fileApproverMap = new Map();
    const fileTeamApproverMap = new Map();
    
    // Iterate through each file in the PR
    for (const file of files.data) {
      const filePath = file.filename;
      const approvers = new Set(); // Use Set to avoid duplicates
      const teamApprovers = new Set(); // Use Set to avoid duplicates
      
      // Check if config has patterns section
      if (approversConfig.patterns) {
        // Iterate through each pattern in the config
        for (const patternConfig of approversConfig.patterns) {
          const pattern = patternConfig.pattern;
          
          // Use minimatch to check if file matches the pattern
          if (minimatch(filePath, pattern)) {
            // Add individual owners
            if (patternConfig.owners) {
              if (Array.isArray(patternConfig.owners)) {
                patternConfig.owners.forEach(approver => approvers.add(approver));
              } else if (typeof patternConfig.owners === 'string') {
                approvers.add(patternConfig.owners);
              }
            }
            
            // Add team owners
            if (patternConfig['team-owners']) {
              if (Array.isArray(patternConfig['team-owners'])) {
                patternConfig['team-owners'].forEach(teamApprover => teamApprovers.add(teamApprover));
              } else if (typeof patternConfig['team-owners'] === 'string') {
                teamApprovers.add(patternConfig['team-owners']);
              }
            }
          }
        }
      }
      
      // If no specific pattern matched, use fallback approvers if available
      if (approvers.size === 0 && teamApprovers.size === 0 && approversConfig.fallback) {
        if (approversConfig.fallback.owners) {
          if (Array.isArray(approversConfig.fallback.owners)) {
            approversConfig.fallback.owners.forEach(approver => approvers.add(approver));
          } else if (typeof approversConfig.fallback.owners === 'string') {
            approvers.add(approversConfig.fallback.owners);
          }
        }
        
        if (approversConfig.fallback['team-owners']) {
          if (Array.isArray(approversConfig.fallback['team-owners'])) {
            approversConfig.fallback['team-owners'].forEach(teamApprover => teamApprovers.add(teamApprover));
          } else if (typeof approversConfig.fallback['team-owners'] === 'string') {
            teamApprovers.add(approversConfig.fallback['team-owners']);
          }
        }
      }
      
      // Convert Set to Array and store in maps
      fileApproverMap.set(filePath, Array.from(approvers));
      fileTeamApproverMap.set(filePath, Array.from(teamApprovers));
    }
    
    return { fileApproverMap, fileTeamApproverMap };
  }

  /**
   * Request reviews from all approvers and post confirmation/error comments
   * @param {object} context - Probot context object
   * @param {object} pull_request - Pull request object
   * @param {Map<string, string[]>} fileApproverMap - Map of file paths to arrays of approvers
   * @param {Map<string, string[]>} fileTeamApproverMap - Map of file paths to arrays of team approvers
   * @returns {Promise<void>}
   */
  async function requestReviewsFromApprovers(context, pull_request, fileApproverMap, fileTeamApproverMap) {
    // Collect all unique approvers from the fileApproverMap
    const allApprovers = new Set();
    for (const approvers of fileApproverMap.values()) {
      approvers.forEach(approver => allApprovers.add(approver));
    }
    
    // Collect all unique team approvers from the fileTeamApproverMap
    const allTeamApprovers = new Set();
    for (const teamApprovers of fileTeamApproverMap.values()) {
      teamApprovers.forEach(teamApprover => allTeamApprovers.add(teamApprover));
    }

    // Request reviews from all unique approvers and team approvers
    if (allApprovers.size > 0 || allTeamApprovers.size > 0) {
      const reviewers = Array.from(allApprovers);
      const teamReviewers = Array.from(allTeamApprovers);
      
      console.log(`Requesting reviews from individuals: ${reviewers.join(', ')}`);
      console.log(`Requesting reviews from teams: ${teamReviewers.join(', ')}`);
      
      try {
        const requestBody = {};
        if (reviewers.length > 0) {
          requestBody.reviewers = reviewers;
        }
        if (teamReviewers.length > 0) {
          requestBody.team_reviewers = teamReviewers;
        }
        
        await context.octokit.pulls.requestReviewers({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          pull_number: pull_request.number,
          ...requestBody
        });
        
        // Post confirmation comment
        let confirmationMessage = "✅ Review requests have been sent to:";
        if (reviewers.length > 0) {
          confirmationMessage += `\n**Individual reviewers:** ${reviewers.join(', ')}`;
        }
        if (teamReviewers.length > 0) {
          confirmationMessage += `\n**Team reviewers:** ${teamReviewers.join(', ')}`;
        }
        
        await context.octokit.issues.createComment({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          issue_number: pull_request.number,
          body: confirmationMessage
        });
      } catch (error) {
        console.error('Failed to request reviews:', error.message);
        
        // Post error comment
        await context.octokit.issues.createComment({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          issue_number: pull_request.number,
          body: `⚠️ Failed to request reviews from some approvers. Error: ${error.message}`
        });
      }
    }
  }

  /**
   * Generate a detailed comment body with file approvers
   * @param {Map<string, string[]>} fileApproverMap - Map of file paths to arrays of approvers
   * @param {Map<string, string[]>} fileTeamApproverMap - Map of file paths to arrays of team approvers
   * @returns {string} - Formatted comment body
   */
  function generateApproversComment(fileApproverMap, fileTeamApproverMap) {
    let commentBody = "## 📋 Approvers Required\n\n";
    
    if (fileApproverMap.size === 0) {
      commentBody += "No files found in this pull request.\n";
    } else {
      commentBody += "The following files require approval:\n\n";
      
      // Group files by approvers for cleaner display
      const approverToFiles = new Map();
      
      for (const [filePath, approvers] of fileApproverMap) {
        const teamApprovers = fileTeamApproverMap.get(filePath) || [];
        
        if (approvers.length === 0 && teamApprovers.length === 0) {
          // Files with no approvers
          const key = "_no_approvers";
          if (!approverToFiles.has(key)) {
            approverToFiles.set(key, []);
          }
          approverToFiles.get(key).push(filePath);
        } else {
          // Files with approvers
          let approverKey = "";
          if (approvers.length > 0) {
            approverKey += `Individual: ${approvers.sort().join(", ")}`;
          }
          if (teamApprovers.length > 0) {
            if (approverKey) approverKey += " | ";
            approverKey += `Teams: ${teamApprovers.sort().join(", ")}`;
          }
          
          if (!approverToFiles.has(approverKey)) {
            approverToFiles.set(approverKey, []);
          }
          approverToFiles.get(approverKey).push(filePath);
        }
      }
      
      // Generate comment sections
      for (const [approvers, files] of approverToFiles) {
        if (approvers === "_no_approvers") {
          commentBody += "### ⚠️ Files with no specific approvers:\n";
          files.forEach(file => {
            commentBody += `- \`${file}\`\n`;
          });
        } else {
          commentBody += `### 👥 Approvers: ${approvers}\n`;
          files.forEach(file => {
            commentBody += `- \`${file}\`\n`;
          });
        }
        commentBody += "\n";
      }
      
      // Add summary
      const totalFiles = fileApproverMap.size;
      const uniqueApprovers = new Set();
      const uniqueTeamApprovers = new Set();
      
      for (const approvers of fileApproverMap.values()) {
        approvers.forEach(approver => uniqueApprovers.add(approver));
      }
      
      for (const teamApprovers of fileTeamApproverMap.values()) {
        teamApprovers.forEach(teamApprover => uniqueTeamApprovers.add(teamApprover));
      }
      
      commentBody += "---\n";
      commentBody += `**Summary:** ${totalFiles} file(s) requiring approval\n`;
      
      if (uniqueApprovers.size > 0) {
        commentBody += `**Individual approvers:** ${Array.from(uniqueApprovers).sort().join(", ")}\n`;
      }
      if (uniqueTeamApprovers.size > 0) {
        commentBody += `**Team approvers:** ${Array.from(uniqueTeamApprovers).sort().join(", ")}\n`;
      }
    }
    
    return commentBody;
  }

  /**
   * Check if a reviewer satisfies approval requirements and determine team memberships
   * @param {object} context - Probot context object
   * @param {string} reviewer - The username of the reviewer
   * @param {Map<string, string[]>} fileApproverMap - Map of file paths to arrays of approvers
   * @param {Map<string, string[]>} fileTeamApproverMap - Map of file paths to arrays of team approvers
   * @returns {Promise<{satisfiedFiles: string[], satisfiedAsIndividual: boolean, satisfiedAsTeamMember: string[]}>}
   */
  async function checkReviewerSatisfaction(context, reviewer, fileApproverMap, fileTeamApproverMap) {
    const satisfiedFiles = [];
    let satisfiedAsIndividual = false;
    const satisfiedAsTeamMember = [];

    // Get all unique team approvers to check membership
    const allTeamApprovers = new Set();
    for (const teamApprovers of fileTeamApproverMap.values()) {
      teamApprovers.forEach(team => allTeamApprovers.add(team));
    }

    // Check team memberships for the reviewer
    const teamMemberships = new Set();
    for (const team of allTeamApprovers) {
      try {
        const membership = await context.octokit.teams.getMembershipForUserInOrg({
          org: context.payload.repository.owner.login,
          team_slug: team,
          username: reviewer
        });
        
        if (membership.data.state === 'active') {
          teamMemberships.add(team);
        }
      } catch (error) {
        // User is not a member of this team, or team doesn't exist
        console.log(`User ${reviewer} is not a member of team ${team} or team doesn't exist`);
      }
    }

    // Check each file to see if this reviewer satisfies the requirements
    for (const [filePath, approvers] of fileApproverMap) {
      const teamApprovers = fileTeamApproverMap.get(filePath) || [];
      
      // Check if reviewer is in the individual approvers list
      const isIndividualApprover = approvers.includes(reviewer);
      
      // Check if reviewer is a member of any required team
      const isTeamMember = teamApprovers.some(team => teamMemberships.has(team));
      
      if (isIndividualApprover || isTeamMember) {
        satisfiedFiles.push(filePath);
        
        if (isIndividualApprover) {
          satisfiedAsIndividual = true;
        }
        
        if (isTeamMember) {
          teamApprovers.forEach(team => {
            if (teamMemberships.has(team) && !satisfiedAsTeamMember.includes(team)) {
              satisfiedAsTeamMember.push(team);
            }
          });
        }
      }
    }

    return { satisfiedFiles, satisfiedAsIndividual, satisfiedAsTeamMember };
  }

  app.on("pull_request.review_requested", async (context) => {
    const { pull_request, requested_team } = context.payload;
    
    // Check if the requested team ends with -approvers
    if (requested_team && requested_team.name.endsWith('-approvers')) {
      console.log(`Team ${requested_team.name} was requested as reviewer for PR #${pull_request.number}`);

      // Read the approvers configuration file from process.env.CONFIG_PATH/${requested_team.name}.yaml
      const configPath = `${process.env.CONFIG_PATH}/${requested_team.name}.yaml`;
      const approversConfig = await readApproversConfig(configPath, context);

      // if approversConfig is null, post comment to the PR saying the configPath was not found
      if (!approversConfig) {
        console.log(`No approvers config found at ${configPath}`);
        return context.octokit.issues.createComment({
          owner: context.payload.repository.owner.login,
          repo: context.payload.repository.name,
          issue_number: pull_request.number,
          body: `No approvers configuration found at \`${configPath}\`. Please check the file path and try again.`
        });
      }      // Comment on the PR
      await context.octokit.issues.createComment({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: pull_request.number,
        body: "Finding appropriate reviewers for this PR..."
      });

      // Find approvers for the files in the PR
      const { fileApproverMap, fileTeamApproverMap } = await findApprovers(context, pull_request, approversConfig);
      
      // Generate detailed comment with file approvers
      const commentBody = generateApproversComment(fileApproverMap, fileTeamApproverMap);
      
      // Post the detailed comment
      await context.octokit.issues.createComment({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: pull_request.number,
        body: commentBody
      });

      // Request reviews from all approvers
      await requestReviewsFromApprovers(context, pull_request, fileApproverMap, fileTeamApproverMap);

      }
  });

  app.on("pull_request_review.submitted", async (context) => {
    const { pull_request, review } = context.payload;
    
    // Only process approved reviews
    if (review.state !== 'approved') {
      return;
    }

    console.log(`Review approved by ${review.user.login} for PR #${pull_request.number}`);

    // Find the requested team that ends with -approvers
    const requestedTeams = pull_request.requested_teams || [];
    const approverTeam = requestedTeams.find(team => team.name.endsWith('-approvers'));
    
    if (!approverTeam) {
      console.log(`No approver team found in requested_teams for PR #${pull_request.number}`);
      return;
    }

    console.log(`Found approver team: ${approverTeam.name}`);

    // Load the config file for this specific team
    const configPath = `${process.env.CONFIG_PATH}/${approverTeam.name}.yaml`;
    const approversConfig = await readApproversConfig(configPath, context);
    
    if (!approversConfig) {
      console.log(`No approvers config found at ${configPath}`);
      return;
    }

    // Find approvers for the files in the PR
    const { fileApproverMap, fileTeamApproverMap } = await findApprovers(context, pull_request, approversConfig);
    
    // Check if this reviewer satisfies any requirements
    const satisfaction = await checkReviewerSatisfaction(context, review.user.login, fileApproverMap, fileTeamApproverMap);
    
    if (satisfaction.satisfiedFiles.length === 0) {
      console.log(`Review by ${review.user.login} does not satisfy any approver requirements`);
      return;
    }
    
    // Generate comment about what this approval satisfies
    let commentBody = `## ✅ Review Approval Received\n\n`;
    commentBody += `**Reviewer:** @${review.user.login}\n`;
    commentBody += `**Review requests satisfied by this approval:**\n`;
    
    if (satisfaction.satisfiedAsIndividual) {
      commentBody += `- ✅ Individual owner: @${review.user.login}\n`;
    }
    
    if (satisfaction.satisfiedAsTeamMember.length > 0) {
      satisfaction.satisfiedAsTeamMember.forEach(team => {
        commentBody += `- ✅ Team owner: @${team}\n`;
      });
    }
    
    // Post the comment
    await context.octokit.issues.createComment({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      issue_number: pull_request.number,
      body: commentBody
    });
  });
};
