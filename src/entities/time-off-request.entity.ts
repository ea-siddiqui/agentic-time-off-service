import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Employee } from './employee.entity';

export enum TimeOffRequestStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  CANCELLED = 'CANCELLED',
}

@Entity({ name: 'time_off_request' })
@Index('idx_employee_status', ['employeeId', 'status'])
@Index('idx_location_leave', ['locationId', 'leaveType'])
export class TimeOffRequest {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ name: 'employee_id', type: 'text' })
  employeeId: string;

  @ManyToOne(() => Employee, (employee) => employee.requests, { nullable: false })
  @JoinColumn({ name: 'employee_id' })
  employee: Employee;

  @Column({ name: 'location_id', type: 'text' })
  locationId: string;

  @Column({ name: 'leave_type', type: 'text' })
  leaveType: string;

  @Column({ name: 'start_date', type: 'date' })
  startDate: string;

  @Column({ name: 'end_date', type: 'date' })
  endDate: string;

  @Column({ name: 'days_requested', type: 'real' })
  daysRequested: number;

  @Column({ type: 'text', enum: TimeOffRequestStatus, default: TimeOffRequestStatus.PENDING })
  status: TimeOffRequestStatus;

  @Column({ name: 'idempotency_key', type: 'text', unique: true })
  idempotencyKey: string;

  @Column({ name: 'hcm_deduction_id', type: 'text', nullable: true })
  hcmDeductionId?: string | null;

  @Column({ name: 'hcm_verified_at', type: 'datetime', nullable: true })
  hcmVerifiedAt?: Date | null;

  @Column({ name: 'hcm_balance_snapshot', type: 'real', nullable: true })
  hcmBalanceSnapshot?: number | null;

  @Column({ name: 'approved_by', type: 'text', nullable: true })
  approvedBy?: string | null;

  @ManyToOne(() => Employee, { nullable: true })
  @JoinColumn({ name: 'approved_by' })
  approver?: Employee | null;

  @Column({ name: 'approved_at', type: 'datetime', nullable: true })
  approvedAt?: Date | null;

  @Column({ name: 'rejected_by', type: 'text', nullable: true })
  rejectedBy?: string | null;

  @ManyToOne(() => Employee, { nullable: true })
  @JoinColumn({ name: 'rejected_by' })
  rejector?: Employee | null;

  @Column({ name: 'rejected_at', type: 'datetime', nullable: true })
  rejectedAt?: Date | null;

  @Column({ name: 'rejection_reason', type: 'text', nullable: true })
  rejectionReason?: string | null;

  @Column({ name: 'cancelled_at', type: 'datetime', nullable: true })
  cancelledAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}
