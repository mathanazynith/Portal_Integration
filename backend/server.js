import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import dotenv from 'dotenv';
import helmet from 'helmet';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import employeeRoutes from './routes/employees.js'; // Add this line
import salaryRoutes from './routes/salaryRoutes.js';
import CustomerRoutes from './routes/CustomerRoutes.js';
import employeeDashboardRoutes from './routes/EmployeeDashboard.js';
import transactionRoutes from './routes/transaction.js'; 
import Invoice from './routes/invoice.js';
import companyRoutes from './routes/companyRoutes.js';
import categoryRoutes from './routes/categoryRoutes.js'
import path from 'path';
import { fileURLToPath } from 'url';
import { startHikeCronJob, startSalaryMonthUpdateJob, startAutoPayslipGenerationJob, startMissingPayslipRecoveryJob, syncSalaryMonthToCurrent } from './services/cronService.js';
import Salary from './models/Salary.js'; // Import Salary model for manual trigger
import salaryTemplateRoutes from './routes/salaryTemplateRoutes.js';
import DesignationRoutes from './routes/designationRoutes.js';
import financialYearRoutes from './routes/financialYearRoutes.js';
import taxSlabRoutes from './routes/taxSlabRoutes.js';
import deductionLimitRoutes from './routes/deductionLimitRoutes.js';
import employeeTaxRegimeRoutes from './routes/employeeTaxRegimeRoutes.js';
import taxRegimeRoutes from "./routes/taxRegimeRoutes.js";
import employeeTaxDeclarationRoutes from "./routes/employeeTaxDeclarationRoutes.js";
import taxCalculationRoutes from "./routes/taxCalculationRoutes.js";



dotenv.config();

const app = express();

// Middleware
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'https://finance.zynith-it.com',
  credentials: true,
  exposedHeaders: ['Content-Disposition', 'content-disposition']
}));
app.use(express.json());

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/employees', employeeRoutes); 
app.use('/api/salaries', salaryRoutes);
app.use('/api/salary-templates', salaryTemplateRoutes);
app.use('/api/customer',CustomerRoutes);
app.use('/api/employee', employeeDashboardRoutes);
app.use('/api/transactions', transactionRoutes);
app.use('/api/billing', Invoice);
app.use('/api/company', companyRoutes);
app.use('/api/categories', categoryRoutes);
app.use('/api/designations', DesignationRoutes);

app.use("/api/tax-regimes", taxRegimeRoutes);
app.use("/api/financial-years", financialYearRoutes);
app.use("/api/tax-slabs", taxSlabRoutes);
app.use("/api/deduction-limits", deductionLimitRoutes);
app.use("/api/employee-tax-regimes", employeeTaxRegimeRoutes);
app.use("/api/employee-tax-declarations", employeeTaxDeclarationRoutes);
app.use("/api/tax-calculation", taxCalculationRoutes );


// Health check
app.get('/api/health', (req, res) => {
  res.status(200).json({ message: 'Server is running!' });
});

// Manual trigger endpoint for testing hike updates
app.post('/api/test-hike-updates', async (req, res) => {
  try {
    console.log('🔄 Manual trigger: Checking for salary hike status updates...');
    
    /** @type {{activated: number, disabled: number}} */
    const result = await Salary.processHikeStatusUpdates();
    
    res.json({
      message: 'Hike status updates processed manually',
      result: result
    });
  } catch (error) {
    console.error('❌ Error in manual trigger:', error);
    res.status(500).json({ 
      message: 'Error processing hike updates',
      error: error.message 
    });
  }
});

// Get hike status info endpoint
app.get('/api/hike-status-info', async (req, res) => {
  try {
    const pendingHikes = await Salary.find({
      activeStatus: 'disabled',
      'hike.applied': true,
      'hike.startDate': { $gt: new Date() }
    }).select('employeeId name hike.startDate monthlyCtc');

    const activatableHikes = await Salary.find({
      activeStatus: 'disabled',
      'hike.applied': true,
      'hike.startDate': { $lte: new Date() }
    }).select('employeeId name hike.startDate monthlyCtc');

    res.json({
      pendingHikes: pendingHikes,
      activatableHikes: activatableHikes,
      currentTime: new Date().toISOString()
    });
  } catch (error) {
    console.error('❌ Error fetching hike status info:', error);
    res.status(500).json({ 
      message: 'Error fetching hike status info',
      error: error.message 
    });
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ message: 'Something went wrong!' });
});

app.get('/', (req, res) => {
  res.send('Backend is running!');
});

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI,
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }
)
  .then(async () => {
    console.log('✅ Connected to MongoDB');
    // Ensure active salaries match the current month & year on startup
    try {
      await syncSalaryMonthToCurrent();
    } catch (syncErr) {
      console.error('⚠️ Could not sync salary month on startup:', syncErr.message);
    }
    // Start the cron jobs after successful database connection
    startHikeCronJob();
    startSalaryMonthUpdateJob();
    startAutoPayslipGenerationJob();
    startMissingPayslipRecoveryJob();
  })
  .catch((error) => console.error('❌ MongoDB connection error:', error));

const PORT = process.env.PORT || 5003;
const MongoDB = process.env.MONGODB_URI ; 
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`${MongoDB}`);
});

export default app;