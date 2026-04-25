import { Column, CreateDateColumn, Entity, JoinColumn, ManyToOne, OneToMany, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { TimeOffRequest } from './time-off-request.entity';

@Entity({ name: 'employee' })
export class Employee {
  @PrimaryColumn({ type: 'text' })
  id: string;

  @Column({ type: 'text' })
  name: string;

  @Column({ type: 'text', unique: true })
  email: string;

  @Column({ name: 'location_id', type: 'text' })
  locationId: string;

  @Column({ name: 'manager_id', type: 'text', nullable: true })
  managerId?: string | null;

  @ManyToOne(() => Employee, (employee) => employee.directReports, { nullable: true })
  @JoinColumn({ name: 'manager_id' })
  manager?: Employee | null;

  @OneToMany(() => Employee, (employee) => employee.manager)
  directReports: Employee[];

  @OneToMany(() => TimeOffRequest, (request) => request.employee)
  requests: TimeOffRequest[];

  @CreateDateColumn({ name: 'created_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'datetime', default: () => 'CURRENT_TIMESTAMP' })
  updatedAt: Date;
}
