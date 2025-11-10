# HTA Tool - Hierarchical Task Analysis Editor & Viewer

This project contains tools for creating and visualizing Hierarchical Task Analysis (HTA) diagrams, along with Penpot MCP (Model Context Protocol) server integration for design interaction.

## HTA Editor (`hta-editor.html`)

An interactive web-based editor for creating and managing hierarchical task analysis diagrams with:
- Text-based input with tab indentation (press Tab to indent)
- Real-time visual hierarchy rendering with orthogonal connectors
- Undo/Redo support (Ctrl+Z / Ctrl+Y)
- Line selection with Shift+Arrow Up/Down
- Tab/Shift+Tab for indentation control of selected lines
- Auto-update hierarchy 3 seconds after typing stops
- Click tasks to highlight corresponding text in the editor
- Scrollable view for large hierarchies
- Export-ready visualization

## Getting Started with HTA Tools

Simply open `hta-editor.html` in your web browser. No installation required!

1. Open `hta-editor.html` in any modern browser
2. Enter your task hierarchy in the text panel using tabs for indentation
3. The diagram updates automatically after 3 seconds
4. Click on any task in the diagram to jump to its text

### Example Format

```
Root Task
	Subtask 1
		Sub-subtask 1.1
		Sub-subtask 1.2
	Subtask 2
```

### Penpot Design File

The repository includes `HTA.penpot` - a Penpot design file with an example HTA diagram. You can:
- Open it in [Penpot](https://penpot.app) to view and edit the design
- Use it as a template for creating professional HTA diagrams
- Collaborate with others on HTA designs

---

## Penpot MCP Server Setup

This project is also configured to use the Penpot MCP server, which allows AI tools like Cursor to interact with your Penpot designs.

## Setup Instructions

### 1. Install the Penpot MCP Server

The easiest way is to use `uvx` (comes with uv):

```bash
# Install uv if you don't have it
curl -LsSf https://astral.sh/uv/install.sh | sh

# The server will be automatically installed when configured
```

Alternatively, you can install via pip:

```bash
pip install penpot-mcp
```

### 2. Configure Your Credentials

#### Option A: Using Environment Variables (Recommended)

1. Copy the example environment file:
   ```bash
   cp env.template .env
   ```

2. Edit `.env` and add your actual Penpot credentials:
   ```
   PENPOT_API_URL=https://design.penpot.app/api
   PENPOT_USERNAME=your_actual_username
   PENPOT_PASSWORD=your_actual_password
   ```

#### Option B: Using MCP Configuration File

1. Copy the template configuration:
   ```bash
   cp mcp-config.template.json mcp-config.json
   ```

2. Edit `mcp-config.json` and add your Penpot token:
   ```json
   {
     "mcpServers": {
       "penpot": {
         "command": "uvx",
         "args": ["penpot-mcp"],
         "env": {
           "PENPOT_API_URL": "https://design.penpot.app/api",
           "PENPOT_TOKEN": "your_actual_penpot_token_here"
         }
       }
     }
   }
   ```

#### Option C: Configure in Cursor Settings

1. Open Cursor Settings
2. Navigate to MCP Servers configuration
3. Add the configuration manually in Cursor's settings

### 3. Restart Cursor

After configuration, restart Cursor to load the MCP server.

## Usage

Once configured, you can interact with your Penpot designs directly in Cursor by asking questions like:

- "Show me all projects in my Penpot account"
- "Analyze the design components in project X"
- "Export the main button component as an image"
- "What design patterns are used in this file?"

## Penpot Account

If you don't have a Penpot account yet:
- Sign up at [https://penpot.app](https://penpot.app)
- Or use the self-hosted version if your organization has one

## Security Note

⚠️ **IMPORTANT: Protect Your Credentials!**

Never commit sensitive files to version control:
- `.env` - Contains your credentials and tokens
- `mcp-config.json` - Contains your Penpot token
- Any other files with passwords or API keys

The `.gitignore` file is configured to exclude these files automatically. Only the template files (`env.template` and `mcp-config.template.json`) are tracked in git - these are safe to share as they don't contain actual credentials.

## Resources

- [Penpot MCP GitHub Repository](https://github.com/montevive/penpot-mcp)
- [Penpot Official Documentation](https://help.penpot.app)
- [Model Context Protocol Specification](https://modelcontextprotocol.io)

