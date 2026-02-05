// ===================================
// FINANCE TRACKER - PHASE 4B
// Multi-Year System & Archive Management
// ===================================

/**
 * Check if an item is active in a given year
 */
function isItemActiveInYear(item, year) {
    if (!item.startDate) {
        // Legacy items without dates - add default start date
        item.startDate = `${year}-01-01`;
        return true;
    }
    
    const startYear = parseInt(item.startDate.split('-')[0]);
    const endYear = item.endDate ? parseInt(item.endDate.split('-')[0]) : 9999;
    
    return year >= startYear && year <= endYear;
}

/**
 * Check if an item has ended
 */
function isItemEnded(item) {
    if (!item.endDate) return false;
    
    const today = new Date();
    const endDate = new Date(item.endDate);
    
    return today > endDate;
}

/**
 * Ensure all items have start/end date fields
 */
function migrateItemDates() {
    Object.keys(tracker.data.years).forEach(year => {
        const yearData = tracker.data.years[year];
        
        // Migrate credit cards
        if (yearData.credit) {
            yearData.credit.forEach(card => {
                if (!card.startDate) {
                    card.startDate = `${year}-01-01`;
                }
                if (card.endDate === undefined) {
                    card.endDate = null;
                }
            });
        }
        
        // Migrate loans
        if (yearData.loans) {
            yearData.loans.forEach(loan => {
                if (!loan.startDate) {
                    loan.startDate = `${year}-01-01`;
                }
                if (loan.endDate === undefined) {
                    loan.endDate = null;
                }
            });
        }
        
        // Migrate subscriptions
        if (yearData.subscriptions) {
            yearData.subscriptions.forEach(sub => {
                if (!sub.startDate) {
                    sub.startDate = `${year}-01-01`;
                }
                if (sub.endDate === undefined) {
                    sub.endDate = null;
                }
            });
        }
    });
}

/**
 * Sync items across all years
 * This is the KEY function that makes multi-year work!
 */
function syncItemsAcrossYears() {
    // First, migrate any items that don't have dates yet
    migrateItemDates();
    
    const allYears = Object.keys(tracker.data.years).map(y => parseInt(y)).sort((a, b) => a - b);
    
    // Build master lists from all years (deduplicated)
    const masterCredit = new Map();
    const masterLoans = new Map();
    const masterSubscriptions = new Map();
    
    allYears.forEach(year => {
        const yearData = tracker.data.years[year];
        
        // Collect credit cards
        yearData.credit?.forEach(card => {
            const key = `${card.name}-${card.type || 'default'}`;
            if (!masterCredit.has(key)) {
                masterCredit.set(key, {...card});
            } else {
                // Merge data from different years (keep most complete version)
                const existing = masterCredit.get(key);
                // Update if this version has more complete data
                Object.keys(card).forEach(field => {
                    if (card[field] && !existing[field]) {
                        existing[field] = card[field];
                    }
                });
            }
        });
        
        // Collect loans
        yearData.loans?.forEach(loan => {
            const key = `${loan.loanPaidTo}-${loan.loanNumber || 'default'}`;
            if (!masterLoans.has(key)) {
                masterLoans.set(key, {...loan});
            } else {
                const existing = masterLoans.get(key);
                Object.keys(loan).forEach(field => {
                    if (loan[field] && !existing[field]) {
                        existing[field] = loan[field];
                    }
                });
            }
        });
        
        // Collect subscriptions
        yearData.subscriptions?.forEach(sub => {
            const key = sub.subscriptionTo;
            if (!masterSubscriptions.has(key)) {
                masterSubscriptions.set(key, {...sub});
            } else {
                const existing = masterSubscriptions.get(key);
                Object.keys(sub).forEach(field => {
                    if (sub[field] && !existing[field]) {
                        existing[field] = sub[field];
                    }
                });
            }
        });
    });
    
    // Now propagate items to all relevant years
    allYears.forEach(year => {
        const yearData = tracker.data.years[year];
        
        // Ensure arrays exist
        if (!yearData.credit) yearData.credit = [];
        if (!yearData.loans) yearData.loans = [];
        if (!yearData.subscriptions) yearData.subscriptions = [];
        
        // Sync credit cards
        const yearCreditKeys = new Set(yearData.credit.map(c => `${c.name}-${c.type || 'default'}`));
        masterCredit.forEach((card, key) => {
            if (isItemActiveInYear(card, year) && !yearCreditKeys.has(key)) {
                // Add this card to this year
                yearData.credit.push({...card, log: initializeMonthlyLog()});
            }
        });
        
        // Sync loans
        const yearLoanKeys = new Set(yearData.loans.map(l => `${l.loanPaidTo}-${l.loanNumber || 'default'}`));
        masterLoans.forEach((loan, key) => {
            if (isItemActiveInYear(loan, year) && !yearLoanKeys.has(key)) {
                yearData.loans.push({...loan, log: initializeMonthlyLog()});
            }
        });
        
        // Sync subscriptions
        const yearSubKeys = new Set(yearData.subscriptions.map(s => s.subscriptionTo));
        masterSubscriptions.forEach((sub, key) => {
            if (isItemActiveInYear(sub, year) && !yearSubKeys.has(key)) {
                yearData.subscriptions.push({...sub});
            }
        });
    });
    
    console.log('✅ Items synced across years');
}

/**
 * Initialize monthly log structure
 */
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

/**
 * Run sync on year change
 */
const originalChangeYear = window.changeYear;
window.changeYear = function(delta) {
    originalChangeYear(delta);
    syncItemsAcrossYears();
};

/**
 * Run sync on data import
 */
const originalTrackerImport = tracker.importData.bind(tracker);
tracker.importData = function(jsonString) {
    const result = originalTrackerImport(jsonString);
    if (result) {
        syncItemsAcrossYears();
    }
    return result;
};

// Run initial sync on page load
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(() => {
            syncItemsAcrossYears();
        }, 200);
    });
} else {
    setTimeout(() => {
        syncItemsAcrossYears();
    }, 200);
}

console.log('✅ Phase 4b: Multi-Year System Module Loaded');

