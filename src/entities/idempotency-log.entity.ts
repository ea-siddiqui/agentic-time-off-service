import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ name: 'idempotency_log' })
@Index('idx_idempotency_expiry', ['expiresAt'])
export class IdempotencyLog {
  @PrimaryColumn({ name: 'idempotency_key', type: 'text' })
  idempotencyKey: string;

  @Column({ type: 'text' })
  endpoint: string;

  @Column({ name: 'response_body', type: 'text' })
  responseBody: string;

  @Column({ name: 'status_code', type: 'integer' })
  statusCode: number;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @Column({ name: 'expires_at', type: 'datetime' })
  expiresAt: Date;
}
