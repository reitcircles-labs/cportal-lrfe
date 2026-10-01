import { DataTypes } from 'sequelize';

export const SCHEMA = 'identity';

/** Sequelize models for the `identity` Postgres schema. */
export function defineModels(sequelize) {
    const opts = (extra = {}) => ({ schema: SCHEMA, freezeTableName: true, ...extra });

    const User = sequelize.define('user', {
        id: { type: DataTypes.UUID, primaryKey: true, defaultValue: DataTypes.UUIDV4 },
        name: { type: DataTypes.STRING, allowNull: false },
        email: { type: DataTypes.STRING, allowNull: false, unique: true },
        office: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
        status: { type: DataTypes.ENUM('Active', 'Suspended', 'Invited'), allowNull: false, defaultValue: 'Invited' },
        passwordHash: { type: DataTypes.STRING },
        mfaEnrolled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
        // TODO: encrypt MFA secrets at rest (KMS / envelope key) before production.
        mfaSecret: { type: DataTypes.STRING },
        pendingMfaSecret: { type: DataTypes.STRING },
        inviteHash: { type: DataTypes.STRING, unique: true },
        inviteExpiresAt: { type: DataTypes.DATE },
        lastActiveAt: { type: DataTypes.DATE }
    }, opts());

    const Role = sequelize.define('role', {
        id: { type: DataTypes.STRING, primaryKey: true },
        label: { type: DataTypes.STRING, allowNull: false },
        desc: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' },
        home: { type: DataTypes.STRING, allowNull: false, defaultValue: '/' },
        system: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
        perms: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] }
    }, opts());

    const UserRole = sequelize.define('user_role', {
        userId: { type: DataTypes.UUID, primaryKey: true },
        roleId: { type: DataTypes.STRING, primaryKey: true }
    }, opts({ timestamps: false }));

    const SodRule = sequelize.define('sod_rule', {
        id: { type: DataTypes.STRING, primaryKey: true },
        a: { type: DataTypes.STRING, allowNull: false },
        b: { type: DataTypes.STRING, allowNull: false },
        label: { type: DataTypes.STRING, allowNull: false },
        enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true }
    }, opts());

    const Setting = sequelize.define('setting', {
        key: { type: DataTypes.STRING, primaryKey: true },
        value: { type: DataTypes.JSONB, allowNull: false }
    }, opts());

    const Session = sequelize.define('session', {
        id: { type: DataTypes.UUID, primaryKey: true },
        userId: { type: DataTypes.UUID, allowNull: false },
        refreshHash: { type: DataTypes.STRING, allowNull: false },
        lastSeenAt: { type: DataTypes.DATE, allowNull: false },
        revokedAt: { type: DataTypes.DATE },
        ip: { type: DataTypes.STRING }
    }, opts({ indexes: [{ fields: ['userId'] }] }));

    const AccessEvent = sequelize.define('access_event', {
        id: { type: DataTypes.BIGINT, primaryKey: true, autoIncrement: true },
        time: { type: DataTypes.DATE, allowNull: false },
        actorId: { type: DataTypes.UUID },
        actor: { type: DataTypes.STRING, allowNull: false },
        kind: { type: DataTypes.ENUM('role', 'user', 'policy', 'denied', 'session'), allowNull: false },
        action: { type: DataTypes.STRING, allowNull: false },
        target: { type: DataTypes.STRING, allowNull: false, defaultValue: '' },
        detail: { type: DataTypes.TEXT, allowNull: false, defaultValue: '' }
    }, opts({ timestamps: false, indexes: [{ fields: ['kind'] }, { fields: ['time'] }] }));

    return { User, Role, UserRole, SodRule, Setting, Session, AccessEvent };
}
