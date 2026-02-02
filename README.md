# MyGala Post Service

A serverless backend service for managing posts, likes, and comments for MyGala occasions (weddings, events, etc.). Built with AWS Lambda, API Gateway, and Serverless Framework.

## Features

- **Post Management**: Create, read, update, and delete posts with images
- **Social Interactions**: Like/unlike posts and comments
- **Comments**: Add, edit, and delete comments on posts with nested reply support
- **Timeline Generation**: Automatic occasion-based timeline generation with caching
- **Real-time Updates**: Background processing via SNS for async operations
- **Scalable**: Built on AWS serverless infrastructure

## Architecture

This service uses:
- **AWS Lambda** for serverless compute
- **API Gateway** for RESTful API endpoints
- **AWS SNS** for async background task processing
- **Redis** for caching and timeline management
- **RDS (MySQL)** for persistent data storage

## Prerequisites

- Node.js 16.x or higher
- AWS Account with appropriate permissions
- AWS CLI configured
- Serverless Framework (`npm install -g serverless`)
- Access to required infrastructure:
  - Redis instance
  - RDS MySQL instance
  - VPC with appropriate subnets and security groups

## Installation

1. Clone the repository:
```bash
git clone https://github.com/mygala-in/bk-post.git
cd bk-post
```

2. Initialize Git submodules (if you have access to private repositories):
```bash
git submodule update --init --recursive
```

**Note:** The `bk-config` and `bk-utils` directories are Git submodules pointing to private repositories. If you don't have access, see the `.examples/` directory for templates and interfaces.

3. Install dependencies:
```bash
npm install
```

4. Set up configuration files (see [Configuration](#configuration) section)

## Configuration

### Git Submodules

This repository uses Git submodules for configuration and shared utilities:
- `bk-config` - Configuration files (private repository)
- `bk-utils` - Shared utility libraries (private repository)

**For team members with access:**
```bash
git submodule update --init --recursive
```

**For external users:** See the `.examples/` directory for:
- `.examples/bk-config/` - Configuration file templates and documentation
- `.examples/bk-utils/` - Required utility interfaces and documentation

### Required Configuration Files

The service requires configuration files in the `bk-config` directory.

#### 1. Create AWS Configuration

Create `bk-config/configs.dev.json` (and `configs.prod.json` for production):

```json
{
  "envPrefix": "your-environment-prefix",
  "awsRegion": "ap-south-1",
  "awsAccountId": "YOUR_AWS_ACCOUNT_ID",
  "securityGroup": "sg-xxxxxxxxxxxxxxxxx",
  "subnet1": "subnet-xxxxxxxxxxxxxxxxx",
  "subnet2": "subnet-xxxxxxxxxxxxxxxxx",
  "subnet3": "subnet-xxxxxxxxxxxxxxxxx",
  "lambdaRole": "arn:aws:iam::YOUR_AWS_ACCOUNT_ID:role/YOUR_LAMBDA_ROLE"
}
```

#### 2. Create Environment Variables

Create `bk-config/envs.dev.json` (and `envs.prod.json` for production):

```json
{
  "REDIS_HOST": "your-redis-host.example.com",
  "REDIS_PORT": "6379",
  "RDS_HOST": "your-rds-host.example.com",
  "RDS_PORT": "3306",
  "RDS_DATABASE": "your_database_name",
  "RDS_USER": "your_database_user",
  "RDS_PASSWORD": "${ssm:/path/to/your/rds/password}",
  "LOG_LEVEL": "info"
}
```

See `bk-config/README.md` for more details on configuration.

### Utility Libraries

This service depends on shared utility libraries (`bk-utils` submodule) which provide:
- Database helpers (RDS)
- Redis helpers
- Logger utilities
- Access control and authentication
- Common helper functions

**For team members:** The submodule will be initialized with `git submodule update --init`

**For external users:** See `.examples/bk-utils/README.md` for required interfaces and how to implement them.

## API Endpoints

### Posts

- `GET /v1/{id}/list` - Get paginated posts for an occasion
- `GET /v1/{id}/recent/list` - Get recent posts for an occasion (public view)
- `POST /v1/new` - Create a new post
- `GET /v1/{id}` - Get a specific post
- `PUT /v1/{id}` - Update a post
- `DELETE /v1/{id}` - Delete a post

### Likes

- `PUT /v1/{id}/like` - Like a post or comment
- `DELETE /v1/{id}/like` - Unlike a post or comment
- `GET /v1/{id}/likes` - Get likes for a post or comment

### Comments

- `POST /v1/{id}/comment` - Add a comment
- `PUT /v1/{id}/comment` - Edit a comment
- `DELETE /v1/{id}/comment` - Delete a comment
- `GET /v1/{id}/comments` - Get comments for a post

## Deployment

### Development

```bash
npm run dev-deploy
```

### Production

```bash
npm run prod-deploy
```

### Custom Domain Setup

To create a custom domain (one-time setup):

```bash
serverless create_domain --stage dev
serverless create_domain --stage prod
```

## Development

### Code Style

This project uses ESLint with Airbnb base configuration:

```bash
npm run lint          # Check for linting errors
npm run lint-fix      # Auto-fix linting errors
```

### Project Structure

```
.
├── handler.js              # API Gateway Lambda handler
├── processor.js            # SNS event processor for background tasks
├── serverless.yml          # Serverless Framework configuration
├── bk-config/             # Configuration files (not in repo)
├── bk-utils/              # Shared utility libraries (submodule)
└── package.json           # Dependencies and scripts
```

## Background Processing

The service uses SNS topics for async background processing:
- Post creation notifications
- Like/unlike processing
- Comment processing
- Timeline cache updates
- Push notifications via FCM

## Security

- Authentication handled via JWT tokens (validated in `bk-utils/access`)
- Authorization checks for occasion membership
- Sensitive configuration externalized
- AWS IAM roles for Lambda execution
- VPC deployment for database access

See `SECURITY_REVIEW.md` for detailed security analysis.

## Contributing

(Add contribution guidelines if accepting external contributions)

## License

ISC

## Support

For issues and questions, please open an issue in the GitHub repository.

## Acknowledgments

Built for the MyGala platform to enable social features for weddings and special occasions.
