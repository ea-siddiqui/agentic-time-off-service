import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ name: 'balance_cache' })
@Index('idx_balance_lookup', ['employeeId', 'locationId', 'leaveType'])
@Index('idx_stale_sweep', ['isStale', 'lastSyncedAt'])
@Index(['employeeId', 'locationId', 'leaveType'], { unique: true })
export class BalanceCache {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ name: 'employee_id', type: 'text' })
  employeeId: string;

  @Column({ name: 'location_id', type: 'text' })
  locationId: string;

  @Column({ name: 'leave_type', type: 'text' })
  leaveType: string;

  @Column({ name: 'balance_days', type: 'real' })
  balanceDays: number;

  @Column({ name: 'last_synced_at', type: 'datetime' })
  lastSyncedAt: Date;

  @Column({ name: 'sync_source', type: 'text' })
  syncSource: string;

  @Column({ name: 'is_stale', type: 'boolean', default: false })
  isStale: boolean;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}
