/**
 * @param {import('probot').Probot} app
 */
module.exports = (app) => {
  console.log("Yay! The app was loaded!");

  app.on("pull_request.review_requested", async (context) => {
    const { pull_request, requested_team } = context.payload;
    
    // Check if the requested team ends with -apprivers
    if (requested_team && requested_team.name.endsWith('-approvers')) {
      console.log(`Team ${requested_team.name} was requested as reviewer for PR #${pull_request.number}`);
      
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
