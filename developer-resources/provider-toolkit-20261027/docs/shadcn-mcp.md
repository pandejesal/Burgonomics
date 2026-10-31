# Official shadcn MCP documentation

Source: https://ui.shadcn.com/docs/mcp
Retrieved UTC: 2026-10-27T14:49:38.029716+00:00

Public webpage text snapshot for local development reference. Not an API conformance or vendor-approval verdict; copyright remains with the publisher. Scripts/styles were not retained or executed.

---

Sections
Introduction
Components
AI Elements
Installation
Theming
CLI
Typeset
Skills
Registry
Changelog
Components
Accordion
Alert
Alert Dialog
Aspect Ratio
Attachment
Avatar
Badge
Breadcrumb
Bubble
Button
Button Group
Calendar
Card
Carousel
Chart
Checkbox
Code Block
Collapsible
Combobox
Command
Context Menu
Data Table
Date Picker
Dialog
Direction
Drawer
Dropdown Menu
Empty
Field
Hover Card
Input
Input Group
Input OTP
Item
Kbd
Label
Marker
Menubar
Message
Message Scroller
Native Select
Navigation Menu
Pagination
Popover
Progress
Questionnaire
Radio Group
Resizable
Scroll Area
Select
Separator
Sheet
Sidebar
Skeleton
Slider
Spinner
Switch
Table
Tabs
Textarea
Toast
Toggle
Toggle Group
Tooltip
Trace
Typography
AI Elements
Introduction
Chain of Thought
Chat
Checkpoint
Confirmation
Context
File Tree
Inline Citation
Message
Model Selector
Plan
Prompt Input
Queue
Reasoning
Sources
Stack Trace
Subagent
Suggestion
Task
Terminal
Test Results
Tool
Get Started
Installation
components.json
Package Imports
Theming
Typeset
Dark Mode
CLI
Monorepo
Skills
JavaScript
Figma
llms.txt
Legacy Docs
@shadcn/react
Message Scroller
Questionnaire
@shadcn/helpers
AI SDK
TanStack AI
Forms
React Hook Form
TanStack Form
Formisch
Utilities
scroll-fade
shimmer
Registry
Introduction
Getting Started
GitHub Registries
Registry Directory
Registry Health
Examples
Namespaces
Authentication
Dynamic Search
MCP Server
Open in v0
FAQ
API Reference
registry.json
registry-item.json
MCP Server
Copy Page
Previous
Next
Use the shadcn MCP server to browse, search, and install components from registries.
The shadcn MCP Server allows AI assistants to interact with items from registries. You can browse available components, search for specific ones, and install them directly into your project using natural language.
For example, you can ask an AI assistant to "Build a landing page using components from the acme registry" or "Find me a login form from the shadcn registry".
Registries are configured in your project's
components.json
file.
components.json
Copy
{
"registries"
: {
"@acme"
:
"https://acme.com/r/{name}.json"
}
}
Quick Start
#
Select your MCP client and follow the instructions to configure the shadcn MCP server. If you'd like to do it manually, see the
Configuration
section.
Claude Code
Cursor
VS Code
Codex
OpenCode
Run the following command
in your project:
pnpm
npm
yarn
bun
pnpm dlx shadcn@latest mcp init --client claude
Copy
Restart Claude Code
and try the following prompts:
Show me all available components in the shadcn registry
Add the button, dialog and card components to my project
Create a contact form using components from the shadcn registry
Note:
You can use
/mcp
command in Claude Code to debug the MCP server.
What is MCP?
#
Model Context Protocol (MCP)
is an open protocol that enables AI assistants to securely connect to external data sources and tools. With the shadcn MCP server, your AI assistant gains direct access to:
Browse Components
- List all available components, blocks, and templates from any configured registry
Search Across Registries
- Find specific components by name or functionality across multiple sources
Install with Natural Language
- Add components using simple conversational prompts like "add a login form"
Support for Multiple Registries
- Access public registries, private company libraries, and third-party sources
How It Works
#
The MCP server acts as a bridge between your AI assistant, component registries and the shadcn CLI.
Registry Connection
- MCP connects to configured registries (shadcn/ui, private registries, third-party sources)
Natural Language
- You describe what you need in plain English
AI Processing
- The assistant translates your request into registry commands
Component Delivery
- Resources are fetched and installed in your project
Supported Registries
#
The shadcn MCP server works out of the box with any shadcn-compatible registry.
shadcn/ui Registry
- The default registry with all shadcn/ui components
Third-Party Registries
- Any registry following the shadcn registry specification
Private Registries
- Your company's internal component libraries
Namespaced Registries
- Multiple registries configured with
@namespace
syntax
Configuration
#
You can use any MCP client to interact with the shadcn MCP server. Here are the instructions for the most popular ones.
Claude Code
#
To use the shadcn MCP server with Claude Code, add the following configuration to your project's
.mcp.json
file:
.mcp.json
Copy
{
"mcpServers"
: {
"shadcn"
: {
"command"
:
"npx"
,
"args"
: [
"shadcn@latest"
,
"mcp"
]
}
}
}
After adding the configuration, restart Claude Code and run
/mcp
to see the shadcn MCP server in the list. If you see
Connected
, you're good to go.
See the
Claude Code MCP documentation
for more details.
Cursor
#
To configure MCP in Cursor, add the shadcn server to your project's
.cursor/mcp.json
configuration file:
.cursor/mcp.json
Copy
{
"mcpServers"
: {
"shadcn"
: {
"command"
:
"npx"
,
"args"
: [
"shadcn@latest"
,
"mcp"
]
}
}
}
After adding the configuration, enable the shadcn MCP server in Cursor Settings.
Once enabled, you should see a green dot next to the shadcn server in the MCP server list and a list of available tools.
See the
Cursor MCP documentation
for more details.
VS Code
#
To configure MCP in VS Code with GitHub Copilot, add the shadcn server to your project's
.vscode/mcp.json
configuration file:
.vscode/mcp.json
Copy
{
"servers"
: {
"shadcn"
: {
"command"
:
"npx"
,
"args"
: [
"shadcn@latest"
,
"mcp"
]
}
}
}
After adding the configuration, open
.vscode/mcp.json
and click
Start
next to the shadcn server.
See the
VS Code MCP documentation
for more details.
Codex
#
Note:
The
shadcn
CLI cannot automatically update
~/.codex/config.toml
.
You'll need to add the configuration manually.
To configure MCP in Codex, add the shadcn server to
~/.codex/config.toml
:
~/.codex/config.toml
Copy
[
mcp_servers
.
shadcn
]
command =
"npx"
args = [
"shadcn@latest"
,
"mcp"
]
After adding the configuration, restart Codex to load the MCP server.
Configuring Registries
#
The MCP server supports multiple registries through your project's
components.json
configuration. This allows you to access components from various sources including private registries and third-party providers.
Configure additional registries in your
components.json
:
components.json
Copy
{
"registries"
: {
"@acme"
:
"https://registry.acme.com/{name}.json"
,
"@internal"
: {
"url"
:
"https://internal.company.com/{name}.json"
,
"headers"
: {
"Authorization"
:
"Bearer ${REGISTRY_TOKEN}"
}
}
}
}
Note:
No configuration is needed to access the standard shadcn/ui
registry.
Authentication
#
For private registries requiring authentication, set environment variables in your
.env.local
:
.env.local
Copy
REGISTRY_TOKEN
=
your_token_here
API_KEY
=
your_api_key_here
For more details on registry authentication, see the
Authentication documentation
.
Example Prompts
#
Once the MCP server is configured, you can use natural language to interact with registries. Try one of the following prompts:
Browse & Search
#
Show me all available components in the shadcn registry
Find me a login form from the shadcn registry
Install Items
#
Add the button component to my project
Create a login form using shadcn components
Install the Cursor rules from the acme registry
Work with Namespaces
#
Show me components from acme registry
Install @internal/auth-form
Build me a landing page using hero, features and testimonials sections from the acme registry
Troubleshooting
#
MCP Not Responding
#
If the MCP server isn't responding to prompts:
Check Configuration
- Verify the MCP server is properly configured and enabled in your MCP client
Restart MCP Client
- Restart your MCP client after configuration changes
Verify Installation
- Ensure
shadcn
is installed in your project
Check Network
- Confirm you can access the configured registries
Registry Access Issues
#
If components aren't loading from registries:
Check components.json
- Verify registry URLs are correct
Test Authentication
- Ensure environment variables are set for private registries
Verify Registry
- Confirm the registry is online and accessible
Check Namespace
- Ensure namespace syntax is correct (
@namespace/component
)
Installation Failures
#
If components fail to install:
Check Project Setup
- Ensure you have a valid
components.json
file
Verify Paths
- Confirm the target directories exist
Check Permissions
- Ensure write permissions for component directories
Review Dependencies
- Check that required dependencies are installed
No Tools or Prompts
#
If you see the
No tools or prompts
message, try the following:
Clear the npx cache
- Run
npx clear-npx-cache
Re-enable the MCP server
- Try to re-enable the MCP server in your MCP client
Check Logs
- In Cursor, you can see the logs under View -> Output and select
MCP: project-*
in the dropdown.
Learn More
#
Registry Documentation
- Complete guide to shadcn registries
Namespaces
- Configure multiple registry sources
Authentication
- Secure your private registries
MCP Specification
- Learn about Model Context Protocol
Registry Directory
Your project is ready!
On This Page
Quick Start
What is MCP?
How It Works
Supported Registries
Configuration
Claude Code
Cursor
VS Code
Codex
Configuring Registries
Authentication
Example Prompts
Browse & Search
Install Items
Work with Namespaces
Troubleshooting
MCP Not Responding
Registry Access Issues
Installation Failures
No Tools or Prompts
Learn More
Deploy your shadcn/ui app on Vercel
Trusted by OpenAI, Sonos, Adobe, and more.
Vercel provides tools and infrastructure to deploy apps and features at scale.
Deploy Now
Deploy to Vercel
