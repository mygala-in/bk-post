# Example Files and Templates

This directory contains example files and documentation for the private Git submodules used by this repository.

## Purpose

The main repository uses Git submodules for:
- `bk-config` - Configuration files (private repository)
- `bk-utils` - Shared utility libraries (private repository)

These examples help external users understand:
- What configuration is required
- What utility interfaces need to be implemented
- How to set up the repository without access to private submodules

## For Team Members

If you have access to the private repositories, initialize the submodules instead of using these examples:

```bash
git submodule update --init --recursive
```

This will clone the actual `bk-config` and `bk-utils` repositories into their respective directories.

## For External Users

Use these examples to understand the structure and create your own implementations:

### Configuration (bk-config)
See `.examples/bk-config/` for:
- `README.md` - Configuration file documentation
- `configs.example.json` - AWS configuration template
- `envs.example.json` - Environment variables template

### Utilities (bk-utils)
See `.examples/bk-utils/` for:
- `README.md` - Complete interface documentation for all required utilities

## Directory Structure

```
.examples/
├── README.md (this file)
├── bk-config/
│   ├── README.md
│   ├── configs.example.json
│   └── envs.example.json
└── bk-utils/
    └── README.md
```

## Note

When the submodules are initialized (for team members), the actual `bk-config/` and `bk-utils/` directories will be populated with the real implementation from the private repositories. These example files exist separately in `.examples/` to remain available as reference.
