// ===================================
// FINANCE TRACKER - DATA STRUCTURE MIGRATION
// Restructure: Move items from year-children to root-level master lists
// ===================================

/**
 * Generate unique ID for items
 */
function generateId() {
    return 'id_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
}

/**
 * Main migration function - converts old structure (v1.0) to new (v2.0)
 */
function migrateDataStructure() {
    // Check if already migrated
    if (tracker.data.version === '2.0' && tracker.data.creditCards !== undefined) {
        console.log('✅ Data structure already migrated (v2.0)');
        return;
    }
    
    console.log('🔄 Migrating data structure from v1.0 to v2.0...');
    
    // Initialize master lists if they don't exist
    if (!tracker.data.creditCards) tracker.data.creditCards = [];
    if (!tracker.data.loans) tracker.data.loans = [];
    if (!tracker.data.subscriptions) tracker.data.subscriptions = [];
    
    // Maps to deduplicate items
    const creditMap = new Map();
    const loanMap = new Map();
    const subMap = new Map();
    
    // Collect all items from all years (old structure)
    Object.keys(tracker.data.years).forEach(year => {
        const yearData = tracker.data.years[year];
        
        // Migrate credit cards
        if (yearData.credit && Array.isArray(yearData.credit)) {
            yearData.credit.forEach(card => {
                // Create unique fingerprint
                const fingerprint = `${card.name || 'Card'}-${card.type || 'unknown'}-${card.limit || 0}`;
                
                if (!creditMap.has(fingerprint)) {
                    const cardWithId = {
                        id: card.id || generateId(),
                        name: card.name || 'Credit Card',
                        type: card.type || '',
                        limit: card.limit || 0,
                        dueDate: card.dueDate || 1,
                        closingDate: card.closingDate || 1,
                        notes: card.notes || '',
                        startDate: card.startDate || `${year}-01-01`,
                        endDate: card.endDate || null
                    };
                    
                    creditMap.set(fingerprint, cardWithId);
                    tracker.data.creditCards.push(cardWithId);
                }
                
                // Store log with ID reference
                const cardId = creditMap.get(fingerprint).id;
                if (card.log) {
                    if (!yearData.creditLogs) yearData.creditLogs = {};
                    yearData.creditLogs[cardId] = card.log;
                }
            });
            
            // Remove old structure
            delete yearData.credit;
        }
        
        // Migrate loans
        if (yearData.loans && Array.isArray(yearData.loans)) {
            yearData.loans.forEach(loan => {
                const fingerprint = `${loan.loanPaidTo || 'Loan'}-${loan.loanNumber || 'unknown'}`;
                
                if (!loanMap.has(fingerprint)) {
                    const loanWithId = {
                        id: loan.id || generateId(),
                        loanPaidTo: loan.loanPaidTo || 'Loan',
                        loanLender: loan.loanLender || '',
                        accountNumber: loan.accountNumber || '',
                        loanNumber: loan.loanNumber || '',
                        dueDate: loan.dueDate || 1,
                        regularPayment: loan.regularPayment || 0,
                        originalAmount: loan.originalAmount || 0,
                        interestRate: loan.interestRate || 0,
                        notes: loan.notes || '',
                        startDate: loan.startDate || `${year}-01-01`,
                        endDate: loan.endDate || null
                    };
                    
                    loanMap.set(fingerprint, loanWithId);
                    tracker.data.loans.push(loanWithId);
                }
                
                const loanId = loanMap.get(fingerprint).id;
                if (loan.log) {
                    if (!yearData.loanLogs) yearData.loanLogs = {};
                    yearData.loanLogs[loanId] = loan.log;
                }
            });
            
            delete yearData.loans;
        }
        
        // Migrate subscriptions
        if (yearData.subscriptions && Array.isArray(yearData.subscriptions)) {
            yearData.subscriptions.forEach(sub => {
                const fingerprint = sub.subscriptionTo || 'Subscription';
                
                if (!subMap.has(fingerprint)) {
                    const subWithId = {
                        id: sub.id || generateId(),
                        subscriptionTo: sub.subscriptionTo || 'Subscription',
                        dateOfPayment: sub.dateOfPayment || '',
                        renewal: sub.renewal || 'Monthly',
                        purpose: sub.purpose || [],
                        charge: sub.charge || 0,
                        perCycle: sub.perCycle || 0,
                        discount: sub.discount || 0,
                        annualTotal: sub.annualTotal || 0,
                        monthlyTotal: sub.monthlyTotal || 0,
                        paymentMethod: sub.paymentMethod || '',
                        orderNumber: sub.orderNumber || '',
                        registrationNumber: sub.registrationNumber || '',
                        link: sub.link || '',
                        email: sub.email || '',
                        notes: sub.notes || '',
                        startDate: sub.startDate || `${year}-01-01`,
                        endDate: sub.endDate || null
                    };
                    
                    subMap.set(fingerprint, subWithId);
                    tracker.data.subscriptions.push(subWithId);
                }
            });
            
            delete yearData.subscriptions;
        }
        
        // Ensure log structures exist
        if (!yearData.creditLogs) yearData.creditLogs = {};
        if (!yearData.loanLogs) yearData.loanLogs = {};
    });
    
    // Update version
    tracker.data.version = '2.0';
    tracker.data.lastModified = new Date().toISOString();
    
    console.log(`✅ Migration complete! Data structure v2.0`);
    console.log(`   📊 ${tracker.data.creditCards.length} credit cards`);
    console.log(`   🏦 ${tracker.data.loans.length} loans`);
    console.log(`   🔄 ${tracker.data.subscriptions.length} subscriptions`);
}

/**
 * Helper functions for the new architecture
 */

// Get active items for current year based on start/end dates
function getActiveItems(items, year, month = null, showArchived = false) {
    const currentDate = month !== null ? new Date(year, month, 15) : new Date(year, 6, 1);
    
    return items.filter(item => {
        if (!item.startDate) return true;
        
        const startDate = new Date(item.startDate);
        const endDate = item.endDate ? new Date(item.endDate) : null;
        
        // Before start: never show
        if (currentDate < startDate) return false;
        
        // Active period: always show
        if (!endDate || currentDate <= endDate) return true;
        
        // After end: show only if archived enabled
        return showArchived;
    });
}

// Get log for specific item in specific year
function getItemLog(itemId, year, logType) {
    const yearData = tracker.data.years[year];
    if (!yearData) return initializeMonthlyLog();
    
    const logs = logType === 'credit' ? yearData.creditLogs : yearData.loanLogs;
    if (logs && logs[itemId]) {
        return logs[itemId];
    }
    
    return initializeMonthlyLog();
}

// Save log for specific item in specific year
function saveItemLog(itemId, year, logType, log) {
    const yearData = tracker.data.years[year];
    if (!yearData) return;
    
    if (logType === 'credit') {
        if (!yearData.creditLogs) yearData.creditLogs = {};
        yearData.creditLogs[itemId] = log;
    } else if (logType === 'loan') {
        if (!yearData.loanLogs) yearData.loanLogs = {};
        yearData.loanLogs[itemId] = log;
    }
}

// Initialize monthly log structure
function initializeMonthlyLog() {
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const log = {};
    
    months.forEach(month => {
        log[month] = {
            paymentDates: [],
            paymentAmounts: [],
            balancePostPay: 0,
            notes: ''
        };
    });
    
    return log;
}

// Run migration on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            migrateDataStructure();
        }, 100);
    });
} else {
    setTimeout(() => {
        migrateDataStructure();
    }, 100);
}

console.log('✅ Data Structure Migration Module Loaded (v2.0)');

