// ===================================
// FINANCE TRACKER - PHASE 2
// Budget Management & Recommendations
// ===================================

/**
 * Initialize budget structure if it doesn't exist
 */
function initializeBudgets() {
    if (!tracker.data.budgets) {
        tracker.data.budgets = {
            monthly: {},
            categories: {}
        };
    }
}

/**
 * Manage budgets interface
 */
function manageBudgets() {
    initializeBudgets();
    
    const currentMonth = new Date().getMonth();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    const monthKeys = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    
    const yearData = tracker.getYearData();
    const currentMonthKey = monthKeys[currentMonth];
    
    // Calculate current spending
    tracker.calculateMonthlyTotals(currentMonthKey);
    const currentSpending = yearData.monthly.moneyOut[currentMonthKey].total || 0;
    const currentIncome = yearData.monthly.moneyIn[currentMonthKey].total || 0;
    
    // Get or estimate budget
    let monthlyBudget = tracker.data.budgets.monthly[currentMonthKey] || 0;
    if (monthlyBudget === 0) {
        // Estimate based on average of last 3 months
        monthlyBudget = estimateMonthlyBudget();
    }
    
    let html = `
        <h2>Budget Management</h2>
        <p style="color: var(--text-secondary); margin-bottom: 1.5rem;">
            Set monthly spending limits and track your progress. Get smart recommendations based on your income and spending patterns.
        </p>
        
        <div style="background: var(--bg-secondary); padding: 1.5rem; border-radius: 12px; margin-bottom: 1.5rem;">
            <h3 style="margin-bottom: 1rem;">Current Month: ${monthNames[currentMonth]} ${tracker.currentYear}</h3>
            
            <div style="margin-bottom: 1rem;">
                <label style="display: block; margin-bottom: 0.5rem;"><strong>Monthly Spending Budget:</strong></label>
                <div style="display: flex; gap: 0.5rem; align-items: center;">
                    <span style="font-size: 1.5rem;">$</span>
                    <input type="number" step="0.01" id="monthlyBudgetInput" value="${monthlyBudget}" 
                           placeholder="0.00"
                           style="flex: 1; padding: 0.75rem; border-radius: 8px; font-size: 1.1rem; font-weight: bold;
                                  border: 2px solid var(--border-color); background: var(--bg-primary); 
                                  color: var(--text-primary);">
                    <button class="btn-primary" onclick="saveMonthlyBudget('${currentMonthKey}')">Save</button>
                </div>
                ${monthlyBudget === 0 ? 
                    `<small style="color: var(--accent-primary);">💡 Recommended: $${estimateMonthlyBudget().toFixed(2)} based on your income</small>` : 
                    ''}
            </div>
            
            ${monthlyBudget > 0 ? generateBudgetProgress(currentSpending, monthlyBudget) : ''}
            
            <div style="margin-top: 1rem; padding-top: 1rem; border-top: 1px solid var(--border-color);">
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span><strong>Income this month:</strong></span>
                    <span style="color: var(--success); font-weight: bold;">${formatCurrency(currentIncome)}</span>
                </div>
                <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                    <span><strong>Spending this month:</strong></span>
                    <span style="color: var(--danger); font-weight: bold;">${formatCurrency(currentSpending)}</span>
                </div>
                <div style="display: flex; justify-content: space-between; padding-top: 0.5rem; border-top: 1px solid var(--border-color);">
                    <span><strong>Net (Income - Spending):</strong></span>
                    <span style="color: ${currentIncome - currentSpending >= 0 ? 'var(--success)' : 'var(--danger)'}; font-weight: bold;">
                        ${formatCurrency(currentIncome - currentSpending)}
                    </span>
                </div>
            </div>
        </div>
        
        <div style="background: var(--bg-secondary); padding: 1.5rem; border-radius: 12px; margin-bottom: 1.5rem;">
            <h3 style="margin-bottom: 1rem;">Category Budgets</h3>
            <p style="color: var(--text-secondary); margin-bottom: 1rem; font-size: 0.9rem;">
                Set limits for specific spending categories to track where your money goes.
            </p>
            
            <div id="categoryBudgetsContainer">
                ${generateCategoryBudgets()}
            </div>
            
            <button class="btn-secondary" onclick="addCategoryBudget()" style="margin-top: 1rem;">
                + Add Category Budget
            </button>
        </div>
        
        <div style="background: linear-gradient(135deg, rgba(79, 70, 229, 0.1), rgba(124, 58, 237, 0.1)); 
                    padding: 1.5rem; border-radius: 12px; border-left: 4px solid var(--accent-primary); margin-bottom: 1.5rem;">
            <h3 style="margin-bottom: 1rem;">💡 Budget Recommendations</h3>
            ${generateBudgetRecommendations()}
        </div>
        
        <div style="display: flex; gap: 1rem;">
            <button class="btn-secondary" onclick="closeModal()">Close</button>
            <button class="btn-primary" onclick="applyRecommendedBudget()">Apply Recommended Budget</button>
        </div>
    `;
    
    showModal(html);
}

/**
 * Generate budget progress bar
 */
function generateBudgetProgress(spent, budget) {
    const percentage = Math.min((spent / budget) * 100, 100);
    const remaining = Math.max(budget - spent, 0);
    
    let color = 'var(--success)';
    let status = 'On Track';
    
    if (percentage >= 100) {
        color = 'var(--danger)';
        status = 'Over Budget!';
    } else if (percentage >= 80) {
        color = 'var(--warning)';
        status = 'Nearing Limit';
    }
    
    return `
        <div style="margin-top: 1rem;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                <span style="font-weight: 600;">${status}</span>
                <span style="font-weight: 600; color: ${color};">${percentage.toFixed(1)}%</span>
            </div>
            <div style="background: var(--bg-tertiary); height: 20px; border-radius: 10px; overflow: hidden;">
                <div style="background: ${color}; height: 100%; width: ${percentage}%; transition: all 0.3s ease;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.9rem;">
                <span>Spent: <strong>${formatCurrency(spent)}</strong></span>
                <span>Remaining: <strong style="color: ${color};">${formatCurrency(remaining)}</strong></span>
            </div>
        </div>
    `;
}

/**
 * Generate category budgets list
 */
function generateCategoryBudgets() {
    const categoryBudgets = tracker.data.budgets.categories || {};
    
    if (Object.keys(categoryBudgets).length === 0) {
        return '<p style="color: var(--text-secondary); font-style: italic;">No category budgets set yet.</p>';
    }
    
    let html = '<div style="display: flex; flex-direction: column; gap: 0.75rem;">';
    
    Object.entries(categoryBudgets).forEach(([categoryId, budget]) => {
        const category = findCategoryById(categoryId);
        if (!category) return;
        
        const currentMonth = new Date().getMonth();
        const monthKeys = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
        const yearData = tracker.getYearData();
        const spent = yearData.monthly.moneyOut[monthKeys[currentMonth]][categoryId] || 0;
        const percentage = budget > 0 ? Math.min((spent / budget) * 100, 100) : 0;
        
        let color = 'var(--success)';
        if (percentage >= 100) color = 'var(--danger)';
        else if (percentage >= 80) color = 'var(--warning)';
        
        html += `
            <div style="padding: 0.75rem; background: var(--bg-primary); border-radius: 8px; border: 1px solid var(--border-color);">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem;">
                    <strong>${category.name}</strong>
                    <div style="display: flex; gap: 0.5rem; align-items: center;">
                        <span style="font-size: 0.9rem;">${formatCurrency(spent)} / ${formatCurrency(budget)}</span>
                        <button class="btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;" 
                                onclick="removeCategoryBudget('${categoryId}')">✕</button>
                    </div>
                </div>
                <div style="background: var(--bg-tertiary); height: 8px; border-radius: 4px; overflow: hidden;">
                    <div style="background: ${color}; height: 100%; width: ${percentage}%;"></div>
                </div>
            </div>
        `;
    });
    
    html += '</div>';
    return html;
}

/**
 * Find category by ID
 */
function findCategoryById(categoryId) {
    const income = tracker.data.categories.income.find(c => c.id === categoryId);
    if (income) return income;
    
    const spending = tracker.data.categories.spending.find(c => c.id === categoryId);
    return spending;
}

/**
 * Estimate monthly budget based on income
 */
function estimateMonthlyBudget() {
    const yearData = tracker.getYearData();
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const currentMonth = new Date().getMonth();
    
    // Get average income from last 3 months
    let totalIncome = 0;
    let count = 0;
    
    for (let i = Math.max(0, currentMonth - 2); i <= currentMonth; i++) {
        const income = yearData.monthly.moneyIn[months[i]]?.total || 0;
        if (income > 0) {
            totalIncome += income;
            count++;
        }
    }
    
    const avgIncome = count > 0 ? totalIncome / count : 0;
    
    // Recommend 80% of average income as budget (20% for savings/buffer)
    return avgIncome * 0.8;
}

/**
 * Generate budget recommendations
 */
function generateBudgetRecommendations() {
    const yearData = tracker.getYearData();
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const currentMonth = new Date().getMonth();
    const currentMonthKey = months[currentMonth];
    
    const avgIncome = estimateMonthlyBudget() / 0.8; // Reverse calculation
    const recommendedBudget = estimateMonthlyBudget();
    
    let recommendations = [];
    
    // Income-based recommendation
    if (avgIncome > 0) {
        recommendations.push(`
            <li><strong>Spending Limit:</strong> Based on your average income of ${formatCurrency(avgIncome)}, 
            we recommend a monthly budget of ${formatCurrency(recommendedBudget)} (80% of income).
            This leaves 20% for savings and unexpected expenses.</li>
        `);
    }
    
    // Spending trend analysis
    const currentSpending = yearData.monthly.moneyOut[currentMonthKey]?.total || 0;
    if (currentSpending > recommendedBudget * 0.8) {
        recommendations.push(`
            <li><strong>Spending Alert:</strong> You're currently at ${formatCurrency(currentSpending)} this month, 
            which is ${((currentSpending / recommendedBudget) * 100).toFixed(0)}% of your recommended budget. 
            Consider reducing discretionary spending.</li>
        `);
    }
    
    // Category recommendations
    const highestSpending = findHighestSpendingCategory();
    if (highestSpending) {
        recommendations.push(`
            <li><strong>Top Spending Category:</strong> Your highest spending is in "${highestSpending.name}" 
            at ${formatCurrency(highestSpending.amount)}. Consider setting a budget for this category.</li>
        `);
    }
    
    // Savings recommendation
    const currentIncome = yearData.monthly.moneyIn[currentMonthKey]?.total || 0;
    const netSavings = currentIncome - currentSpending;
    if (netSavings < avgIncome * 0.2 && avgIncome > 0) {
        recommendations.push(`
            <li><strong>Savings Goal:</strong> Aim to save at least ${formatCurrency(avgIncome * 0.2)} per month 
            (20% of income). You're currently ${netSavings >= 0 ? 'saving' : 'over budget by'} ${formatCurrency(Math.abs(netSavings))}.</li>
        `);
    }
    
    if (recommendations.length === 0) {
        return '<p>Great job! Your spending is well-balanced. Keep up the good work! 🎉</p>';
    }
    
    return '<ul style="margin: 0; padding-left: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem;">' + 
           recommendations.join('') + '</ul>';
}

/**
 * Find highest spending category
 */
function findHighestSpendingCategory() {
    const yearData = tracker.getYearData();
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const currentMonth = new Date().getMonth();
    const currentMonthKey = months[currentMonth];
    
    let highest = null;
    
    tracker.data.categories.spending.forEach(cat => {
        const amount = yearData.monthly.moneyOut[currentMonthKey][cat.id] || 0;
        if (!highest || amount > highest.amount) {
            highest = { name: cat.name, amount: amount };
        }
    });
    
    return highest;
}

/**
 * Save monthly budget
 */
function saveMonthlyBudget(monthKey) {
    const input = document.getElementById('monthlyBudgetInput');
    const budget = parseFloat(input.value) || 0;
    
    if (budget < 0) {
        showToast('Budget must be a positive number', 'error');
        return;
    }
    
    tracker.saveState();
    initializeBudgets();
    tracker.data.budgets.monthly[monthKey] = budget;
    
    showToast('Monthly budget saved!', 'success');
    manageBudgets(); // Refresh
}

/**
 * Apply recommended budget
 */
function applyRecommendedBudget() {
    const recommended = estimateMonthlyBudget();
    const currentMonth = new Date().getMonth();
    const monthKeys = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    
    tracker.saveState();
    initializeBudgets();
    tracker.data.budgets.monthly[monthKeys[currentMonth]] = recommended;
    
    showToast(`Budget set to ${formatCurrency(recommended)}!`, 'success');
    manageBudgets(); // Refresh
}

/**
 * Add category budget
 */
function addCategoryBudget() {
    const spending = tracker.data.categories.spending;
    
    let options = '';
    spending.forEach(cat => {
        options += `<option value="${cat.id}">${cat.name}</option>`;
    });
    
    showModal(`
        <h2>Add Category Budget</h2>
        <form id="addCategoryBudgetForm" style="display: flex; flex-direction: column; gap: 1rem;">
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Category:</label>
                <select id="categoryBudgetSelect" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                        border: 1px solid var(--border-color); background: var(--bg-primary); 
                        color: var(--text-primary);">
                    ${options}
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Monthly Budget:</label>
                <input type="number" step="0.01" id="categoryBudgetAmount" placeholder="0.00" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div style="display: flex; gap: 1rem;">
                <button type="submit" class="btn-primary">Add Budget</button>
                <button type="button" class="btn-secondary" onclick="closeModal(); manageBudgets();">Cancel</button>
            </div>
        </form>
    `);
    
    document.getElementById('addCategoryBudgetForm').addEventListener('submit', (e) => {
        e.preventDefault();
        
        const categoryId = document.getElementById('categoryBudgetSelect').value;
        const amount = parseFloat(document.getElementById('categoryBudgetAmount').value) || 0;
        
        if (amount <= 0) {
            showToast('Budget must be greater than 0', 'error');
            return;
        }
        
        tracker.saveState();
        initializeBudgets();
        tracker.data.budgets.categories[categoryId] = amount;
        
        closeModal();
        manageBudgets();
        showToast('Category budget added!', 'success');
    });
}

/**
 * Remove category budget
 */
function removeCategoryBudget(categoryId) {
    tracker.saveState();
    delete tracker.data.budgets.categories[categoryId];
    manageBudgets(); // Refresh
    showToast('Category budget removed', 'success');
}

// Hook into the manage budgets button (attach when settings view is shown)
function attachBudgetButton() {
    const btn = document.getElementById('manageBudgetsBtn');
    if (btn && !btn.hasAttribute('data-listener-attached')) {
        btn.addEventListener('click', manageBudgets);
        btn.setAttribute('data-listener-attached', 'true');
        console.log('✅ Budget button listener attached');
    }
}

// Hook into switchView to attach when settings is shown
const originalSwitchView = window.switchView;
window.switchView = function(viewName) {
    originalSwitchView(viewName);
    if (viewName === 'settings') {
        setTimeout(attachBudgetButton, 100);
    }
};

// Try attaching immediately and after load
attachBudgetButton();
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
        setTimeout(attachBudgetButton, 200);
    });
} else {
    setTimeout(attachBudgetButton, 200);
}

console.log('✅ Phase 2: Budget Management Module Loaded');
