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
   * @returns {Promise<Map<string, string[]>>} - Map of file paths to arrays of approvers
   */
  async function findApprovers(context, pull_request, approversConfig) {
    const { minimatch } = require('minimatch');
    
    const files = await context.octokit.pulls.listFiles({
      owner: context.payload.repository.owner.login,
      repo: context.payload.repository.name,
      pull_number: pull_request.number
    });

    const fileApproverMap = new Map();
    
    // Iterate through each file in the PR
    for (const file of files.data) {
      const filePath = file.filename;
      const approvers = new Set(); // Use Set to avoid duplicates
      
      // Check if config has patterns section
      if (approversConfig.patterns) {
        // Iterate through each pattern in the config
        for (const pattern of Object.keys(approversConfig.patterns)) {
          // Use minimatch to check if file matches the pattern
          if (minimatch(filePath, pattern)) {
            const patternApprovers = approversConfig.patterns[pattern];
            // Add approvers (can be string or array)
            if (Array.isArray(patternApprovers)) {
              patternApprovers.forEach(approver => approvers.add(approver));
            } else if (typeof patternApprovers === 'string') {
              approvers.add(patternApprovers);
            }
          }
        }
      }
      
      // If no specific pattern matched, use fallback approvers if available
      if (approvers.size === 0 && approversConfig.fallback) {
        if (Array.isArray(approversConfig.fallback)) {
          approversConfig.fallback.forEach(approver => approvers.add(approver));
        } else if (typeof approversConfig.fallback === 'string') {
          approvers.add(approversConfig.fallback);
        }
      }
      
      // Convert Set to Array and store in map
      fileApproverMap.set(filePath, Array.from(approvers));
    }
    
    return fileApproverMap;
  }

  /**
   * Generate a detailed comment body with file approvers
   * @param {Map<string, string[]>} fileApproverMap - Map of file paths to arrays of approvers
   * @returns {string} - Formatted comment body
   */
  function generateApproversComment(fileApproverMap) {
    let commentBody = "## 📋 Approvers Required\n\n";
    
    if (fileApproverMap.size === 0) {
      commentBody += "No files found in this pull request.\n";
    } else {
      commentBody += "The following files require approval:\n\n";
      
      // Group files by approvers for cleaner display
      const approverToFiles = new Map();
      
      for (const [filePath, approvers] of fileApproverMap) {
        if (approvers.length === 0) {
          // Files with no approvers
          const key = "_no_approvers";
          if (!approverToFiles.has(key)) {
            approverToFiles.set(key, []);
          }
          approverToFiles.get(key).push(filePath);
        } else {
          // Files with approvers
          const approverKey = approvers.sort().join(", ");
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
      for (const approvers of fileApproverMap.values()) {
        approvers.forEach(approver => uniqueApprovers.add(approver));
      }
      
      commentBody += "---\n";
      commentBody += `**Summary:** ${totalFiles} file(s) requiring approval from ${uniqueApprovers.size} approver(s)\n`;
      
      if (uniqueApprovers.size > 0) {
        commentBody += `**All required approvers:** ${Array.from(uniqueApprovers).sort().join(", ")}\n`;
      }
    }
    
    return commentBody;
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
      const fileApproverMap = await findApprovers(context, pull_request, approversConfig);
      
      // Generate detailed comment with file approvers
      const commentBody = generateApproversComment(fileApproverMap);
      
      // Post the detailed comment
      await context.octokit.issues.createComment({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: pull_request.number,
        body: commentBody
      });

      }
  });

};
