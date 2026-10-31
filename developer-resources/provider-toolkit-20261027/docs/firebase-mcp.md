# Official Firebase MCP documentation

Source: https://firebase.google.com/docs/ai-assistance/mcp-server
Retrieved UTC: 2026-10-27T14:49:37.860561+00:00

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Firebase
Documentation
Develop with AI assistance
AI
Send feedback
Firebase MCP server
Stay organized with collections
Save and categorize content based on your preferences.
The
Firebase MCP
server
is a
local Model Context Protocol (MCP) server that runs in your development
environment to give AI-powered development tools the ability to work with your
Firebase projects and your app's codebase.
The Firebase MCP server works with any tool that can act as an MCP client,
including:
Antigravity
, Claude Code and Claude Desktop, Cline, Cursor, VS Code Copilot, Windsurf, and more!
arrow_downward
Jump to setup instructions
Benefits of the MCP server
An editor configured to use the Firebase MCP server can use its AI capabilities
to help you:
Create and manage Firebase projects
Manage your
Firebase Authentication
users
Work with data in
Cloud Firestore
and
Firebase SQL Connect
Retrieve
Firebase SQL Connect
schemas
Understand your security rules for
Cloud Firestore
and
Cloud Storage for Firebase
Send messages with
Firebase Cloud Messaging
These are only partial lists; see the
server capabilities
section for a complete list of tools available to your editor.
Tip:
Consider using
Firebase agent skills
alongside the MCP server to help your AI assistant understand Firebase best
practices and execute complex tasks with higher accuracy and lower cost. For
example, for tasks like setting up services like
Authentication
,
Cloud Firestore
, or
Firebase AI Logic
for web or mobile apps, or deploying web apps to
Firebase Hosting
or
App Hosting
, agent skills can provide a more guided
and efficient experience than prompts like
/firebase:init
or
/firebase:deploy
. When you have both the Firebase MCP server and Firebase
agent skills installed, skills can teach AI agents how to use the MCP tools to
accomplish complex tasks efficiently.
Set up your MCP client
The Firebase MCP server is a local MCP server that can work with any MCP client
that supports standard I/O (stdio) as the transport medium.
When the Firebase MCP server makes tool calls, it runs locally in your
environment using the same user credentials that authorize the
Firebase
CLI.
This could be a logged-in user or
Application Default
Credentials
,
depending on the environment.
Note:
Although the Firebase MCP server runs locally on your machine, some tools
(such as certain
Cloud Firestore
tools) proxy requests to a relevant remote MCP
server or backend service to interact with your cloud-hosted resources.
Before you begin
Make sure you have a working installation of Node.js and npm.
Basic configuration
Here are basic configuration instructions for using the Firebase MCP server with
some popular AI-assistive tools:
Antigravity
To configure
Antigravity
to use the Firebase MCP server:
In
Antigravity
, click the
more_horiz
menu in the Agent pane >
MCP Servers
.
Select
Firebase
>
Install
.
This automatically updates your
mcp_config.json
file, which you can view by
clicking
Manage MCP Servers
at the top of the MCP Store pane >
View raw config
, with the following content:
{
"mcpServers"
:
{
"firebase-mcp-server"
:
{
"command"
:
"npx"
,
"args"
:
[
"-y"
,
"firebase-tools@latest"
,
"mcp"
]
}
}
}
Claude
Claude Code
Option 1
: Install via plugin (Recommended)
The easiest way to set up the Firebase MCP server in Claude Code is to
install the official Firebase plugin:
Add the Firebase marketplace for Claude plugins:
claude
plugin
marketplace
add
firebase/firebase-tools
Install the Claude plugin for Firebase:
claude
plugin
install
firebase@firebase
Verify the installation:
claude
plugin
marketplace
list
Option 2
: Configure MCP server manually
Alternatively, you can manually configure the Firebase MCP server:
Run the following command under your app folder:
claude
mcp
add
firebase
npx
--
-y
firebase-tools@latest
mcp
Verify the installation:
claude
mcp
list
It should show:
firebase: npx -y firebase-tools@latest mcp - ✓ Connected
Claude Desktop
To configure Claude Desktop to use the Firebase MCP server, edit the
claude_desktop_config.json
file. You can open or create this file from the
Claude > Settings
menu. Select the
Developer
tab, then click
Edit Config
.
{
"mcpServers"
:
{
"firebase"
:
{
"command"
:
"npx"
,
"args"
:
[
"-y"
,
"firebase-tools@latest"
,
"mcp"
]
}
}
}
Cursor
Option 1: Marketplace plugin
(recommended)
Install the
Firebase plugin from the Cursor Marketplace
.
This automatically configures the MCP server and provides access to
Firebase agent skills
.
Option 2: One-click MCP setup
If you only want to add the MCP server to your global configuration, click the
following button:
Option 3: Manual configuration
If you prefer to configure the server for a specific project or want to edit
your settings manually, update your
mcp.json
file:
For a specific project, edit
.cursor/mcp.json
For all projects (global), edit
~/.cursor/mcp.json
"mcpServers"
:
{
"firebase"
:
{
"command"
:
"npx"
,
"args"
:
[
"-y"
,
"firebase-tools@latest"
,
"mcp"
]
}
}
Cline
To configure Cline to use the Firebase MCP server, edit the
cline_mcp_settings.json
file. You can open or create this file by clicking
the MCP Servers icon at the top of the Cline pane, then clicking the
Configure MCP Servers
button.
{
"mcpServers"
:
{
"firebase"
:
{
"command"
:
"npx"
,
"args"
:
[
"-y"
,
"firebase-tools@latest"
,
"mcp"
],
"disabled"
:
false
}
}
}
VS Code Copilot
To configure a single project, edit the
.vscode/mcp.json
file in your
workspace:
"servers"
:
{
"firebase"
:
{
"type"
:
"stdio"
,
"command"
:
"npx"
,
"args"
:
[
"-y"
,
"firebase-tools@latest"
,
"mcp"
]
}
}
To make the server available in every project you open, edit your user
settings, for example:
"mcp"
:
{
"servers"
:
{
"firebase"
:
{
"type"
:
"stdio"
,
"command"
:
"npx"
,
"args"
:
[
"-y"
,
"firebase-tools@latest"
,
"mcp"
]
}
}
}
Windsurf
To configure Windsurf Editor, edit the file
~/.codeium/windsurf/mcp_config.json
:
"mcpServers"
:
{
"firebase"
:
{
"command"
:
"npx"
,
"args"
:
[
"-y"
,
"firebase-tools@latest"
,
"mcp"
]
}
}
Optional configuration
In addition to the basic configuration for each client, shown earlier, there are
two optional parameters you can specify:
--dir
ABSOLUTE_DIR_PATH
: The absolute path of a
directory containing
firebase.json
, to set a project context for the MCP
server. If unspecified, the
get_project_directory
and
set_project_directory
tools become available and the default directory
will be the working directory where the MCP server was started.
--only
FEATURE_1
,
FEATURE_2
: A
comma-separated list of feature groups to activate. Use this to limit the
tools exposed to only features you are actively using. Note that the core
tools are always available.
For example:
"firebase"
:
{
"command"
:
"npx"
,
"args"
:
[
"-y"
,
"firebase-tools@latest"
,
"mcp"
,
"--dir"
,
"/Users/turing/my-project"
,
"--only"
,
"auth,firestore,storage"
]
}
MCP server capabilities
The Firebase MCP server provides three different categories of MCP features:
Prompts
: A library of pre-written prompts that you can run;
they're optimized for developing and running an app with Firebase
Tools
: A set of tools intended for use by AI agents that help
them work directly with your Firebase project (with your approval!)
Resources
: Documentation files intended for use by AI
agents to give them more guidance and context to complete a task or goal
Prompts
The Firebase MCP server comes with a library of pre-written prompts optimized
for developing and running an app with Firebase. You can use these prompts to
complete various common tasks or goals with your agentic AI assistants.
The following table describes the prompts the MCP server makes available.
Many development tools that support MCP provide a convenient way to run these
prompts. For example, as a slash command:
/firebase:init
In supported environments, you can start typing
/firebase:
to see a list of
available prompts.
Note:
You can also see this information using the command:
npx firebase-tools@latest mcp --generate-prompt-list
Prompt Name
Feature Group
Description
firebase:deploy
core
Use this command to deploy resources to Firebase.
Arguments:
<prompt> (optional): any specific instructions you wish to provide about deploying
firebase:init
core
Use this command to set up Firebase services, like backend and AI features.
firestore:generate_security_rules
firestore
Generate secure Firebase Firestore Security Rules and corresponding unit tests for your project.
storage:generate_security_rules
storage
Generate secure Firebase Storage Security Rules and corresponding unit tests for your project.
crashlytics:connect
crashlytics
Use this command to access a Firebase application's Crashlytics data.
Tools
The Firebase MCP server also provides a number of tools intended for use by AI
agents that help them work directly with your Firebase project (with your
approval!). Unlike with prompts, you don't call these tools directly; rather, AI
agents that support tool calling (such as
Antigravity
, Claude Code, or Cursor)
can automatically call these tools to perform development tasks when needed.
The following table describes the tools the MCP server makes available.
Note:
You can also see this information using the command:
npx firebase-tools@latest mcp --generate-tool-list
Tool Name
Feature Group
Description
apphosting_fetch_logs
apphosting
Fetch recent service or build logs for an App Hosting backend.
apphosting_list_backends
apphosting
List App Hosting backends, traffic configurations, and custom domains in your project.
auth_get_users
auth
Retrieve Firebase Auth users by UID, email, phone number, or list all users.
auth_update_user
auth
Update a user's account by enabling/disabling it or setting custom claims.
auth_set_sms_region_policy
auth
Set an SMS region policy allowing or denying specific country codes for Firebase Authentication.
firebase_login
core
Sign the user into the Firebase CLI and MCP server or check current authentication status.
firebase_logout
core
Sign the user out of the Firebase CLI and MCP server.
firebase_validate_security_rules
core
Validate syntax and check for errors in Firestore, Storage, or Realtime Database security rules.
firebase_get_project
core
Retrieve metadata and configuration details for the currently active Firebase project.
firebase_list_apps
core
List all Firebase apps registered in the active project.
firebase_list_projects
core
List Firebase projects accessible by the authenticated user.
firebase_get_sdk_config
core
Retrieve SDK configuration details or config file contents for a registered Firebase app.
firebase_create_project
core
Create a new Firebase project or enable Firebase services on an existing Google Cloud project.
firebase_create_app
core
Create a new iOS, Android, or Web app in the active Firebase project.
firebase_create_android_sha
core
Add a SHA-1 or SHA-256 certificate hash to an Android app in the active Firebase project.
firebase_get_environment
core
Retrieve the current Firebase CLI and MCP environment configuration, active project, and authenticated user.
firebase_update_environment
core
Update environment settings such as project directory, active project, or active user account.
firebase_init
core
Initialize and configure Firebase services in your local project workspace.
firebase_get_security_rules
core
Retrieve the active security rules for Firestore, Storage, or Realtime Database.
firebase_read_resources
core
Read the contents of internal firebase:// documentation resources or list all available resources.
firebase_deploy
core
Deploy Firebase services and resources configured in firebase.json to your project.
firebase_deploy_status
core
Check the status and progress of a background deployment job.
crashlytics_create_note
crashlytics
Add a note to a Crashlytics issue for an Android or iOS app.
crashlytics_delete_note
crashlytics
Delete a note from a Crashlytics issue for an Android or iOS app.
crashlytics_get_issue
crashlytics
Retrieve details and metadata for a specific Crashlytics issue.
crashlytics_list_events
crashlytics
List recent crash and exception events matching specified filters for an issue.
crashlytics_batch_get_events
crashlytics
Retrieve sample crash and exception events by resource name for debugging.
crashlytics_list_notes
crashlytics
List all notes attached to a Crashlytics issue for an Android or iOS app.
crashlytics_get_report
crashlytics
Generate aggregated numerical reports for Crashlytics issues and events.
crashlytics_update_issue
crashlytics
Update the state (OPEN or CLOSED) of a Crashlytics issue.
realtimedatabase_get_data
realtimedatabase
Read data from a specified path in the Firebase Realtime Database.
realtimedatabase_set_data
realtimedatabase
Write JSON data to a specified path in the Firebase Realtime Database.
dataconnect_build
dataconnect
Compile Firebase SQL Connect schemas, operations, and connectors to validate syntax and types.
dataconnect_list_services
dataconnect
List local and deployed Firebase SQL Connect services, schemas, and connectors.
dataconnect_execute
dataconnect
Execute a GraphQL query or mutation against a Firebase SQL Connect service or emulator.
functions_get_logs
functions
Retrieve and filter Cloud Functions log entries from Google Cloud Logging.
functions_list_functions
functions
List all deployed Cloud Functions in your Firebase project.
messaging_send_message
messaging
Send a Firebase Cloud Messaging push notification to a device registration token or topic.
remoteconfig_get_template
remoteconfig
Retrieve the active or specified version of the Firebase Remote Config template.
remoteconfig_update_template
remoteconfig
Publish a new Firebase Remote Config template or rollback to a previous version.
storage_get_object_download_url
storage
Retrieve the download URL for an object in a Cloud Storage bucket.
firestore_get_document
firestore
Get a document from a Firestore database.
firestore_add_document
firestore
Create a document from a Firestore database.
firestore_update_document
firestore
Update a document from a Firestore database.
firestore_delete_document
firestore
Delete a document from a Firestore database.
firestore_list_documents
firestore
List documents from a Firestore database.
firestore_list_collections
firestore
List all the collection IDs underneath a document.
firestore_query_collection
firestore
Query Firestore documents from a collection with optional filters and ordering.
firestore_run_aggregation_query
firestore
Run an aggregation query against a Firestore database.
Executes an aggregation query (such as COUNT, SUM, or AVG) over a structured query and returns the aggregated results.
Required Parameters:
-
parent
: The parent resource name in
projects/{project_id}/databases/{database_id}/documents
format (e.g.,
projects/my-project/databases/(default)/documents
).
-
structured_aggregation_query
: A
StructuredAggregationQuery
object defining the aggregation query to execute.
Example usage (COUNT and AVG):
{
"parent"
:
"projects/my-project/databases/(default)/documents"
,
"structured_aggregation_query"
:
{
"structured_query"
:
{
"from"
:
[{
"collection_id"
:
"orders"
}],
"where"
:
{
"field_filter"
:
{
"field"
:
{
"field_path"
:
"status"
},
"op"
:
"EQUAL"
,
"value"
:
{
"string_value"
:
"COMPLETED"
}
}
}
},
"aggregations"
:
[
{
"alias"
:
"total_orders"
,
"count"
:
{}
},
{
"alias"
:
"average_amount"
,
"avg"
:
{
"field"
:
{
"field_path"
:
"amount"
}
}
}
]
}
}
firestore_create_database
firestore
Create a Firestore database.
firestore_get_database
firestore
Get a Firestore database.
firestore_list_databases
firestore
List Firestore databases.
firestore_update_database
firestore
Update a Firestore database.
firestore_delete_database
firestore
Delete a Firestore database.
firestore_create_index
firestore
Create a composite index.
firestore_get_index
firestore
Get a Firestore index.
firestore_list_indexes
firestore
List Firestore indexes.
firestore_delete_index
firestore
Delete a Firestore index.
firestore_get_backup
firestore
Get a Firestore backup.
firestore_list_backups
firestore
List Firestore backups.
firestore_delete_backup
firestore
Delete a Firestore backup.
firestore_create_backup_schedule
firestore
Create a Firestore backup schedule.
firestore_get_backup_schedule
firestore
Get a Firestore backup schedule.
firestore_list_backup_schedules
firestore
List Firestore backup schedules.
firestore_update_backup_schedule
firestore
Update a Firestore backup schedule.
firestore_delete_backup_schedule
firestore
Delete a Firestore backup schedule.
firestore_get_backup
firestore
Get a Firestore backup.
firestore_list_backups
firestore
List Firestore backups.
firestore_delete_backup
firestore
Delete a Firestore backup.
firestore_create_backup_schedule
firestore
Create a Firestore backup schedule.
firestore_get_backup_schedule
firestore
Get a Firestore backup schedule.
firestore_list_backup_schedules
firestore
List Firestore backup schedules.
firestore_update_backup_schedule
firestore
Update a Firestore backup schedule.
firestore_delete_backup_schedule
firestore
Delete a Firestore backup schedule.
developerknowledge_search_documents
developerknowledge
Use this tool to find documentation about Google developer products. The documents contain official APIs, code snippets, release notes, best practices, guides, debugging info, and more. It covers the following products and domains:
* ADK: adk.dev
* Android: developer.android.com
* Apigee: docs.apigee.com
* Chrome: developer.chrome.com
* Dart: dart.dev
* Firebase: firebase.google.com
* Flutter: docs.flutter.dev
* Fuchsia: fuchsia.dev
* Gemini CLI: geminicli.com
* Genkit: genkit.dev
* Go: go.dev
* Google AI: ai.google.dev
* Google Antigravity: antigravity.google
* Google Cloud: cloud.google.com & docs.cloud.google.com
* Google Developers, Ads, Search, Google Maps, Youtube: developers.google.com
* Google Home: developers.home.google.com
* Google Maps Platform: mapsplatform.google.com
* TensorFlow: www.tensorflow.org
* Web: web.dev
This tool returns chunks of text, names, and URLs for matching documents. If the returned chunks are not detailed enough to answer the user's question, use
get_documents
with the
parent
from this tool's output to retrieve the full document content.
developerknowledge_answer_query
developerknowledge
Use answer_query to get a grounded answer to a query about Google developer products. This tool has limited quota. This tool will synthesize information from the corpus to generate an answer to the query. answer_query grounds answers using the same corpus as search_documents.
This tool returns the generated answer_text and a list of document names (references) used to generate the answer. Use get_documents with the document names to fetch the entire document content if needed.
If you get a 429 out of quota error, use search_documents instead.
developerknowledge_get_documents
developerknowledge
Use this tool to retrieve the full content of a single document or up to 20 documents in a single call. The document names should be obtained from the
parent
field of results from a call to the
search_documents
tool. Set the
names
parameter to a list of document names.
Tip:
The Developer Knowledge tools in this table search the same corpus of
official Google developer documentation (including
firebase.google.com
) as
the remote
Developer Knowledge MCP server
.
Resources
The MCP server provides resources, which are documentation files intended for
use by AI agents. Agents that support using resources will automatically include
relevant resources in the session context.
The following table describes the resources the MCP server makes available.
Note:
You can also see this information using the command:
npx firebase-tools@latest mcp --generate-resource-list
Resource Name
Description
app_id_guide
Firebase App Id Guide: guides the coding agent through choosing a Firebase App ID in the current project
crashlytics_investigations_guide
Firebase Crashlytics Investigations Guide: Guides the coding agent when investigating bugs reported in Crashlytics issues, including procedures for diagnosing and fixing crashes.
crashlytics_issues_guide
Firebase Crashlytics Issues Guide: Guides the coding agent when working with Crashlytics issues, including prioritization rules and procedures for diagnosing and fixing issues.
crashlytics_reports_guide
Firebase Crashlytics Reports Guide: Guides the coding agent through requesting Crashlytics reports, including setting appropriate filters and how to understand the metrics. The agent should read this guide before requesting any report.
backend_init_guide
Firebase Backend Init Guide: guides the coding agent through configuring Firebase backend services in the current project
ai_init_guide
Firebase GenAI Init Guide: guides the coding agent through configuring GenAI capabilities in the current project utilizing Firebase
firestore_init_guide
Firestore Init Guide: guides the coding agent through configuring Firestore in the current project
firestore_rules_init_guide
Firestore Rules Init Guide: guides the coding agent through setting up Firestore security rules in the project
auth_init_guide
Firebase Authentication Init Guide: guides the coding agent through configuring Firebase Authentication in the current project
hosting_init_guide
Firebase Hosting Deployment Guide: guides the coding agent through deploying to Firebase Hosting in the current project
Update Environment UI
Visual interface for selecting active Firebase project
Deploy UI
Visual interface for Firebase Deploy
Init UI
Visual interface for Firebase Init
docs
Firebase Docs: loads plain text content from Firebase documentation, e.g.
https://firebase.google.com/docs/functions
becomes
firebase://docs/functions
Send feedback
Except as otherwise noted, the content of this page is licensed under the
Creative Commons Attribution 4.0 License
, and code samples are licensed under the
Apache 2.0 License
. For details, see the
Google Developers Site Policies
. Java is a registered trademark of Oracle and/or its affiliates.
Last updated 2026-10-26 UTC.
Need to tell us more?
[[["Easy to understand","easyToUnderstand","thumb-up"],["Solved my problem","solvedMyProblem","thumb-up"],["Other","otherUp","thumb-up"]],[["Missing the information I need","missingTheInformationINeed","thumb-down"],["Too complicated / too many steps","tooComplicatedTooManySteps","thumb-down"],["Out of date","outOfDate","thumb-down"],["Samples / code issue","samplesCodeIssue","thumb-down"],["Other","otherDown","thumb-down"]],["Last updated 2026-10-26 UTC."],[],[]]
