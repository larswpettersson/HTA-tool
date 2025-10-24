# Penpot MCP Server Setup

This project is configured to use the Penpot MCP (Model Context Protocol) server, which allows AI tools like Cursor to interact with your Penpot designs.

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
   cp .env.example .env
   ```

2. Edit `.env` and add your actual Penpot credentials:
   ```
   PENPOT_API_URL=https://design.penpot.app/api
   PENPOT_USERNAME=your_actual_username
   PENPOT_PASSWORD=your_actual_password
   ```

#### Option B: Configure in Cursor Settings

1. Open Cursor Settings
2. Navigate to MCP Servers configuration
3. Add the following configuration (or use the provided `mcp-config.json` as reference):

```json
{
  "mcpServers": {
    "penpot": {
      "command": "uvx",
      "args": ["penpot-mcp"],
      "env": {
        "PENPOT_API_URL": "https://design.penpot.app/api",
        "PENPOT_USERNAME": "your_penpot_username",
        "PENPOT_PASSWORD": "your_penpot_password"
      }
    }
  }
}
```

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

⚠️ **Never commit your `.env` file to version control!** The `.gitignore` file is configured to exclude it.

## Resources

- [Penpot MCP GitHub Repository](https://github.com/montevive/penpot-mcp)
- [Penpot Official Documentation](https://help.penpot.app)
- [Model Context Protocol Specification](https://modelcontextprotocol.io)

