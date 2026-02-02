# Utility Libraries

This directory should contain shared utility libraries used by the post service.

## Required Utilities

The service expects the following modules to be available in this directory:

### Core Utilities
- `logger.js` - Logging utility
- `errors.js` - Error handling
- `access.js` - Authentication and authorization
- `common.js` - Common helper functions
- `constants.js` - Application constants

### Helper Modules
- `redis.helper.js` - Redis connection and operations
- `sns.helper.js` - SNS publishing helper

### Database Helpers (rds/)
- `rds/rds.users.helper.js` - User data access
- `rds/rds.posts.helper.js` - Post data access
- `rds/rds.likes.helper.js` - Like data access
- `rds/rds.comments.helper.js` - Comment data access
- `rds/rds.assets.helper.js` - Asset data access
- `rds/rds.occasions.helper.js` - Occasion data access
- `rds/rds.occasion.users.helper.js` - Occasion user associations
- `rds/rds.wedding.events.helper.js` - Wedding event data access

## Setup Options

### Option 1: Using Git Submodule (Original Setup)
If you have access to the private `bk-utils` repository:
```bash
git submodule update --init --recursive
```

### Option 2: Implement Your Own Utilities
Create implementations for each required module based on your infrastructure:

1. Create the directory structure:
```bash
mkdir -p bk-utils/rds
```

2. Implement each module according to the interface used in the code

3. Update `.gitmodules` to remove the submodule reference

### Option 3: Use npm Package
Refactor to use an npm package with the required utilities.

## Module Interfaces

### logger.js
```javascript
module.exports = {
  info: (message, ...args) => {},
  error: (error, ...args) => {},
  warn: (message, ...args) => {},
  debug: (message, ...args) => {}
};
```

### errors.js
```javascript
module.exports = {
  handleError: (statusCode, message) => {
    throw { statusCode, message };
  }
};
```

### access.js
```javascript
module.exports = {
  validateRequest: (event, context) => {
    // Validate JWT token and return parsed request
    return {
      decoded: { id: userId, ...claims },
      pathParameters: event.pathParameters,
      queryStringParameters: event.queryStringParameters,
      body: JSON.parse(event.body || '{}'),
      httpMethod: event.httpMethod,
      resourcePath: event.resource
    };
  }
};
```

### redis.helper.js
```javascript
module.exports = {
  transformKey: (key) => key,
  exists: async (key) => boolean,
  set: async (key, value, ttl) => {},
  get: async (key, type = 'string') => {},
  mget: async (keys, type = 'string') => [],
  del: async (key) => {},
  zadd: async (key, score, member) => {},
  zrank: async (key, member) => number,
  zrevrank: async (key, member) => number,
  zrange: async (key, type, start, stop) => [],
  zrevrange: async (key, type, start, stop) => [],
  zcard: async (key) => number,
  zrem: async (key, member) => {},
  lrange: async (key, type) => [],
  llen: async (key) => number,
  lpop: async (key, type) => {},
  lrem: async (key, member) => {},
  rpush: async (key, member) => {},
  expire: async (key, seconds) => {}
};
```

### constants.js
```javascript
module.exports = {
  MINI_PROFILE_FIELDS: ['id', 'username', 'name', 'profilePic'],
  OCCASION_CONFIG: {
    status: {
      verified: 'verified',
      pending: 'pending'
    }
  },
  LIMITS_CONFIG: {
    timeline: {
      recent: {
        likes: 10,
        comments: 10
      }
    }
  },
  REDIS_CONFIG: {
    timeline: {
      occasion: 3600,
      likes: 3600,
      comments: 3600
    }
  },
  APP_NOTIFICATIONS: {
    channels: {
      profile: 'profile',
      post: 'post'
    }
  }
};
```

## Database Schema

The RDS helpers expect the following database tables:
- `users` - User profiles
- `posts` - Post data
- `likes` - Like records
- `comments` - Comment records
- `assets` - Media assets
- `occasions` - Occasions/events
- `occasion_users` - User-occasion associations
- `wedding_events` - Wedding event data

Each helper module should implement appropriate CRUD operations for its table.

## Notes

- All database operations should return promises
- Use connection pooling for RDS connections
- Implement proper error handling
- Add logging for debugging
- Consider implementing retry logic for transient failures
