import { DataTypes } from 'sequelize';

export const SCHEMA = 'bpm';

/** Sequelize models for the `bpm` Postgres schema. */
export function defineModels(sequelize) {
    const opts = (extra = {}) => ({ schema: SCHEMA, freezeTableName: true, timestamps: false, ...extra });
    // A NEW object per attribute: Sequelize writes the column name into each attribute definition,
    // so one shared object would map several attributes onto the same column.
    const uuid = (extra = {}) => ({ type: DataTypes.UUID, ...extra });
    const str = () => ({ type: DataTypes.STRING });
    const date = () => ({ type: DataTypes.DATE });

    const Definition = sequelize.define('process_definition', {
        id: uuid({ primaryKey: true }),
        key: { type: DataTypes.STRING, allowNull: false },
        name: { type: DataTypes.STRING, allowNull: false },
        version: { type: DataTypes.INTEGER, allowNull: false },
        definition: { type: DataTypes.JSONB, allowNull: false },
        deployedBy: { type: DataTypes.STRING },
        deployedAt: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ unique: true, fields: ['key', 'version'] }] }));

    const Instance = sequelize.define('process_instance', {
        id: uuid({ primaryKey: true }),
        definitionId: uuid({ allowNull: false }),
        definitionKey: { type: DataTypes.STRING, allowNull: false },
        definitionVersion: { type: DataTypes.INTEGER, allowNull: false },
        name: { type: DataTypes.STRING, allowNull: false },
        businessKey: { type: DataTypes.STRING },
        variables: { type: DataTypes.JSONB, allowNull: false },
        status: { type: DataTypes.ENUM('active', 'error', 'completed', 'cancelled'), allowNull: false },
        outcome: { type: DataTypes.STRING },
        errorMessage: { type: DataTypes.TEXT },
        startedById: { type: DataTypes.STRING },
        startedByName: { type: DataTypes.STRING },
        startedAt: { type: DataTypes.DATE, allowNull: false },
        endedAt: { type: DataTypes.DATE }
    }, opts({ indexes: [{ fields: ['definitionKey', 'businessKey', 'status'] }, { fields: ['startedById'] }] }));

    const Token = sequelize.define('process_token', {
        id: uuid({ primaryKey: true }),
        instanceId: uuid({ allowNull: false }),
        parentTokenId: uuid(),
        forkGroup: uuid(),
        forkSize: { type: DataTypes.INTEGER },
        currentNode: { type: DataTypes.STRING, allowNull: false },
        scope: { type: DataTypes.JSONB, allowNull: false },
        status: { type: DataTypes.STRING, allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ fields: ['instanceId', 'status'] }, { fields: ['parentTokenId'] }] }));

    const Task = sequelize.define('task', {
        id: uuid({ primaryKey: true }),
        instanceId: uuid({ allowNull: false }),
        tokenId: uuid({ allowNull: false }),
        nodeId: { type: DataTypes.STRING, allowNull: false },
        definitionKey: { type: DataTypes.STRING, allowNull: false },
        businessKey: { type: DataTypes.STRING },
        title: { type: DataTypes.STRING, allowNull: false },
        candidateType: { type: DataTypes.ENUM('perm', 'role', 'user'), allowNull: false },
        candidate: { type: DataTypes.STRING, allowNull: false },
        excludedUserIds: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
        outcomes: { type: DataTypes.JSONB },
        input: { type: DataTypes.JSONB, allowNull: false },
        output: { type: DataTypes.JSONB },
        status: { type: DataTypes.ENUM('created', 'claimed', 'completed', 'cancelled'), allowNull: false },
        createdAt: { type: DataTypes.DATE, allowNull: false },
        dueAt: { type: DataTypes.DATE },
        claimedById: str(), claimedByName: str(), claimedAt: date(),
        completedById: str(), completedByName: str(), completedAt: date()
    }, opts({ indexes: [{ fields: ['status', 'candidateType', 'candidate'] }, { fields: ['claimedById'] }, { fields: ['instanceId'] }] }));

    const History = sequelize.define('history_event', {
        id: uuid({ primaryKey: true }),
        instanceId: uuid({ allowNull: false }),
        tokenId: uuid(),
        type: { type: DataTypes.STRING, allowNull: false },
        payload: { type: DataTypes.JSONB, allowNull: false },
        actorId: { type: DataTypes.STRING },
        actorName: { type: DataTypes.STRING },
        at: { type: DataTypes.DATE, allowNull: false }
    }, opts({ indexes: [{ fields: ['instanceId', 'at'] }] }));

    return { Definition, Instance, Token, Task, History };
}
