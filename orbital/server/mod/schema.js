export const DB_SCHEMA = {
  users: {
    description: 'Application users resolved from the session layer.',
    columns: {
      uuid: 'string primary key',
      username: 'string nullable unique',
      api: 'string nullable default null',
      helperApiKey: 'string nullable unique',
      helperApiKeyCreatedAt: 'string nullable',
      createdAt: 'string not null',
      updatedAt: 'string not null',
    },
  },
  wallets: {
    description: 'CKB wallets associated with users.',
    columns: {
      uuid: 'string nullable indexed',
      address: 'json/jsonb not null',
      lockArg: 'string not null',
      pubkey: 'string not null',
      privkey: 'string not null',
      mnemonic: 'string not null',
      label: 'string not null',
      createdAt: 'string not null',
      updatedAt: 'string not null',
    },
  },
  sessions: {
    description: 'Single active session per user, cached in memory and persisted remotely.',
    columns: {
      uuid: 'string primary key',
      token: 'string not null unique',
      deviceId: 'string nullable indexed',
      user: 'json/jsonb not null',
      expiresAt: 'number not null',
      createdAt: 'string not null',
      updatedAt: 'string not null',
    },
  },
};

export function describeSchema() {
  return DB_SCHEMA;
}
