# Official Razorpay local MCP setup

Source: https://razorpay.com/docs/mcp-server/local
Retrieved UTC: 2026-10-27T14:49:36.211381+00:00

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

On this page
Back to top
Setup Options
Integration Steps
Step 1: Configure Application
Step 2: Restart Application
Next Steps
Setup Guides
Razorpay Local MCP Server Setup
Copy page
Copy page
Complete guide to set up and run the Razorpay MCP Server locally using Docker.
Copy page
Copy page
Available in
🇮🇳 India
The Razorpay Local MCP Server is a self-hosted solution that provides complete control over your infrastructure and access to all available tools without restrictions. Choose this option if you need full functionality or have specific security requirements.
​
Setup Options
Refer to the
Prerequisites
section and then choose a setup method to proceed. You can use
Docker (recommended)
or
build from source
.
Prerequisites
Before setting up the Razorpay Local MCP Server, ensure you have:
Docker
: Container platform for running the MCP server.
Git
: Version control system for cloning repositories (if building from source).
Golang (Go)
: Programming language runtime (if building from source).
Razorpay API Keys
: Generate
API keys
from your Dashboard.
AI-assisted Application
: Claude Desktop, VS Code, or similar AI-assisted application.
Docker Setup Instructions (Recommended)
Clone the repository:
Clone Repo
git
clone
https://github.com/razorpay/razorpay-mcp-server.git
cd
razorpay-mcp-server
Build the Docker image:
Build Docker Image
docker
build
-t
razorpay-mcp-server:latest
The resulting image
razorpay-mcp-server:latest
will be available in your local Docker registry.
Build From Source Instructions
Clone the repository:
Clone Repo
git
clone
https://github.com/razorpay/razorpay-mcp-server.git
cd
razorpay-mcp-server
Build the Go binary:
Build Go Binary
go
build
-o
razorpay-mcp-server
./cmd/razorpay-mcp-server
The resulting binary
razorpay-mcp-server
will be created in your current directory.
​
Integration Steps
​
Step 1: Configure Application
Follow the integration steps given below:
For Claude Desktop
For Visual Studio Code
To use the Razorpay MCP Server with Claude Desktop:
Install
Claude Desktop
.
Go to
Settings
→
Developer
→
Edit Config
.
Add the following to your
claude_desktop_config.json
file:
{
"mcpServers"
: {
"razorpay-mcp-server"
: {
"command"
:
"docker"
,
"args"
: [
"run"
,
"--rm"
,
"-i"
,
"-e"
,
"RAZORPAY_KEY_ID"
,
"-e"
,
"RAZORPAY_KEY_SECRET"
,
"razorpay-mcp-server:latest"
],
"env"
: {
"RAZORPAY_KEY_ID"
:
"your_razorpay_key_id"
,
"RAZORPAY_KEY_SECRET"
:
"your_razorpay_key_secret"
}
}
}
}
Handy Tips
Replace
your_razorpay_key_id
and
your_razorpay_key_secret
with your actual Razorpay API credentials.
Configure MCP servers in Claude Desktop
Open
Visual Studio Code
.
Open Command Palette and type
Preferences: Open User Settings (JSON)
.
Select it from the dropdown to open the settings file.
Paste the following configuration:
{
"mcp"
: {
"inputs"
: [
{
"type"
:
"promptString"
,
"id"
:
"razorpay_key_id"
,
"description"
:
"Razorpay Key ID"
,
"password"
:
false
},
{
"type"
:
"promptString"
,
"id"
:
"razorpay_key_secret"
,
"description"
:
"Razorpay Key Secret"
,
"password"
:
true
}
],
"servers"
: {
"razorpay"
: {
"command"
:
"docker"
,
"args"
: [
"run"
,
"-i"
,
"--rm"
,
"-e"
,
"RAZORPAY_KEY_ID"
,
"-e"
,
"RAZORPAY_KEY_SECRET"
,
"razorpay-mcp-server:latest"
],
"env"
: {
"RAZORPAY_KEY_ID"
:
"${input:razorpay_key_id}"
,
"RAZORPAY_KEY_SECRET"
:
"${input:razorpay_key_secret}"
}
}
}
}
}
Learn more about MCP servers in VS Code’s
agent mode documentation
.
​
Step 2: Restart Application
Restart your AI assistant application after configuration. You should see
Razorpay MCP tools
become available. Test the connection by asking:
Show me available Razorpay tools
.
If successful, you should see the complete list of Razorpay MCP tools, including tools that are restricted in the Remote MCP Server.
​
Next Steps
Once your Local MCP Server is running:
Explore Advanced Features
: Access all tools including refunds and settlements.
Configure Advanced Options
: See
Configuration Guide
for detailed settings.
Review Use Cases
: Check
practical examples
that leverage local-only tools.
Was this page helpful?
Yes
No
Razorpay Remote MCP Server Setup
About Integrations
