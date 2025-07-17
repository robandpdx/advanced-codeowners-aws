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
      }

      // Comment on the PR
      return context.octokit.issues.createComment({
        owner: context.payload.repository.owner.login,
        repo: context.payload.repository.name,
        issue_number: pull_request.number,
        body: "Finding appropriate reviewers for this PR..."
      });
    }
  });

};
