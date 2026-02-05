// ===================================
// FINANCE TRACKER - PHASE 3
// Enhanced Charts & Visualizations
// ===================================

// Store chart instances globally so we can destroy them on re-render
let chartInstances = {
    mainTrend: null,
    spendingPie: null,
    debtPie: null
};

/**
 * Enhanced dashboard rendering with Chart.js
 */
const originalRenderDashboard = window.renderDashboard;
window.renderDashboard = function() {
    // Call original to update stat cards
    originalRenderDashboard();
    
    // Render enhanced charts
    renderTrendChart();
    renderSpendingPieChart();
    renderDebtPieChart();
    renderBudgetProgress();
    renderUpcomingPayments();
};

/**
 * Render income vs spending trend chart with Chart.js
 */
function renderTrendChart() {
    const canvas = document.getElementById('dashboardChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const yearData = tracker.getYearData();
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    
    // Get last 6 months of data
    const currentMonth = new Date().getMonth();
    const startMonth = Math.max(0, currentMonth - 5);
    const endMonth = currentMonth;
    
    const displayMonths = months.slice(startMonth, endMonth + 1);
    const displayLabels = monthNames.slice(startMonth, endMonth + 1);
    
    const incomeData = displayMonths.map(m => yearData.monthly.moneyIn[m].total);
    const spendingData = displayMonths.map(m => yearData.monthly.moneyOut[m].total);
    const netData = displayMonths.map((m, i) => incomeData[i] - spendingData[i]);
    
    // Destroy existing chart if it exists
    if (chartInstances.mainTrend) {
        chartInstances.mainTrend.destroy();
    }
    
    // Get colors based on theme
    const isDark = document.body.classList.contains('dark-mode');
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
    const textColor = isDark ? '#f1f5f9' : '#212529';
    
    chartInstances.mainTrend = new Chart(ctx, {
        type: 'line',
        data: {
            labels: displayLabels,
            datasets: [
                {
                    label: 'Income',
                    data: incomeData,
                    borderColor: '#10b981',
                    backgroundColor: 'rgba(16, 185, 129, 0.1)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4
                },
                {
                    label: 'Spending',
                    data: spendingData,
                    borderColor: '#ef4444',
                    backgroundColor: 'rgba(239, 68, 68, 0.1)',
                    borderWidth: 3,
                    fill: true,
                    tension: 0.4
                },
                {
                    label: 'Net',
                    data: netData,
                    borderColor: '#6366f1',
                    backgroundColor: 'rgba(99, 102, 241, 0.1)',
                    borderWidth: 2,
                    borderDash: [5, 5],
                    fill: false,
                    tension: 0.4
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 2,
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        color: textColor,
                        usePointStyle: true,
                        padding: 15
                    }
                },
                tooltip: {
                    mode: 'index',
                    intersect: false,
                    callbacks: {
                        label: function(context) {
                            let label = context.dataset.label || '';
                            if (label) {
                                label += ': ';
                            }
                            label += formatCurrency(context.parsed.y);
                            return label;
                        }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: {
                        color: textColor,
                        callback: function(value) {
                            return '$' + value.toLocaleString();
                        }
                    },
                    grid: {
                        color: gridColor
                    }
                },
                x: {
                    ticks: {
                        color: textColor
                    },
                    grid: {
                        color: gridColor
                    }
                }
            },
            interaction: {
                mode: 'nearest',
                axis: 'x',
                intersect: false
            }
        }
    });
}

/**
 * Render spending breakdown pie chart
 */
function renderSpendingPieChart() {
    const canvas = document.getElementById('spendingPieChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const yearData = tracker.getYearData();
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const currentMonth = new Date().getMonth();
    const currentMonthKey = months[currentMonth];
    
    // Get spending by category for current month
    const spendingCategories = tracker.data.categories.spending;
    const labels = [];
    const data = [];
    const colors = [
        '#ef4444', '#f59e0b', '#10b981', '#3b82f6', 
        '#6366f1', '#8b5cf6', '#ec4899', '#14b8a6'
    ];
    
    spendingCategories.forEach((cat, index) => {
        const amount = yearData.monthly.moneyOut[currentMonthKey][cat.id] || 0;
        if (amount > 0) {
            labels.push(cat.name);
            data.push(amount);
        }
    });
    
    // Add savings if present
    const savings = yearData.monthly.moneyOut[currentMonthKey].savings || 0;
    if (savings > 0) {
        labels.push('Savings');
        data.push(savings);
    }
    
    // Destroy existing chart
    if (chartInstances.spendingPie) {
        chartInstances.spendingPie.destroy();
    }
    
    const isDark = document.body.classList.contains('dark-mode');
    const textColor = isDark ? '#f1f5f9' : '#212529';
    
    chartInstances.spendingPie = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels,
            datasets: [{
                data: data,
                backgroundColor: colors.slice(0, data.length),
                borderWidth: 2,
                borderColor: isDark ? '#1a1a1a' : '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 1,
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        color: textColor,
                        padding: 10,
                        font: {
                            size: 11
                        }
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = formatCurrency(context.parsed);
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((context.parsed / total) * 100).toFixed(1);
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

/**
 * Render debt breakdown pie chart
 */
function renderDebtPieChart() {
    const canvas = document.getElementById('debtPieChart');
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    const yearData = tracker.getYearData();
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const currentMonth = new Date().getMonth();
    const currentMonthKey = months[currentMonth];
    
    const creditBalance = yearData.monthly.debt[currentMonthKey].creditBalance || 0;
    const loanBalance = yearData.monthly.debt[currentMonthKey].loanBalance || 0;
    
    // Destroy existing chart
    if (chartInstances.debtPie) {
        chartInstances.debtPie.destroy();
    }
    
    const isDark = document.body.classList.contains('dark-mode');
    const textColor = isDark ? '#f1f5f9' : '#212529';
    
    if (creditBalance === 0 && loanBalance === 0) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.font = '16px sans-serif';
        ctx.fillStyle = textColor;
        ctx.textAlign = 'center';
        ctx.fillText('No debt data', canvas.width / 2, canvas.height / 2);
        return;
    }
    
    chartInstances.debtPie = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: ['Credit Card Debt', 'Loan Debt'],
            datasets: [{
                data: [creditBalance, loanBalance],
                backgroundColor: ['#ef4444', '#f59e0b'],
                borderWidth: 2,
                borderColor: isDark ? '#1a1a1a' : '#ffffff'
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: true,
            aspectRatio: 1,
            plugins: {
                legend: {
                    display: true,
                    position: 'bottom',
                    labels: {
                        color: textColor,
                        padding: 10
                    }
                },
                tooltip: {
                    callbacks: {
                        label: function(context) {
                            const label = context.label || '';
                            const value = formatCurrency(context.parsed);
                            const total = context.dataset.data.reduce((a, b) => a + b, 0);
                            const percentage = ((context.parsed / total) * 100).toFixed(1);
                            return `${label}: ${value} (${percentage}%)`;
                        }
                    }
                }
            }
        }
    });
}

/**
 * Render budget progress on dashboard
 */
function renderBudgetProgress() {
    const container = document.getElementById('budgetProgressContainer');
    if (!container) return;
    
    initializeBudgets();
    
    const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
    const currentMonth = new Date().getMonth();
    const currentMonthKey = months[currentMonth];
    
    const budget = tracker.data.budgets.monthly[currentMonthKey] || 0;
    
    if (budget === 0) {
        container.innerHTML = `
            <p style="color: var(--text-secondary); text-align: center;">
                No budget set for this month
            </p>
            <button class="btn-primary" onclick="manageBudgets()" style="width: 100%; margin-top: 1rem;">
                Set Budget
            </button>
        `;
        return;
    }
    
    const yearData = tracker.getYearData();
    const spent = yearData.monthly.moneyOut[currentMonthKey].total || 0;
    const percentage = Math.min((spent / budget) * 100, 100);
    const remaining = Math.max(budget - spent, 0);
    
    let color = '#10b981';
    let status = 'On Track';
    
    if (percentage >= 100) {
        color = '#ef4444';
        status = 'Over Budget!';
    } else if (percentage >= 80) {
        color = '#f59e0b';
        status = 'Nearing Limit';
    }
    
    container.innerHTML = `
        <div style="margin-bottom: 1rem;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 0.5rem;">
                <span style="font-weight: 600;">${status}</span>
                <span style="font-weight: 600; color: ${color};">${percentage.toFixed(1)}%</span>
            </div>
            <div style="background: var(--bg-tertiary); height: 24px; border-radius: 12px; overflow: hidden;">
                <div style="background: ${color}; height: 100%; width: ${percentage}%; transition: all 0.3s ease;"></div>
            </div>
            <div style="display: flex; justify-content: space-between; margin-top: 0.5rem; font-size: 0.9rem;">
                <span>Spent: <strong>${formatCurrency(spent)}</strong></span>
                <span>Budget: <strong>${formatCurrency(budget)}</strong></span>
            </div>
            <div style="text-align: center; margin-top: 0.5rem; font-size: 0.95rem; color: ${color};">
                <strong>${formatCurrency(remaining)} remaining</strong>
            </div>
        </div>
        <button class="btn-secondary" onclick="manageBudgets()" style="width: 100%;">
            Manage Budget
        </button>
    `;
}

/**
 * Render upcoming payments on dashboard
 */
function renderUpcomingPayments() {
    const container = document.getElementById('upcomingPaymentsContainer');
    if (!container) return;
    
    const yearData = tracker.getYearData();
    const today = new Date();
    const currentDay = today.getDate();
    const daysAhead = 7; // Show payments due in next 7 days
    
    const upcoming = [];
    
    // Check credit cards
    if (yearData.credit) {
        yearData.credit.forEach(card => {
            const dueDate = parseInt(card.dueDate);
            if (dueDate >= currentDay && dueDate <= currentDay + daysAhead) {
                upcoming.push({
                    type: 'credit',
                    name: card.name || 'Credit Card',
                    dueDate: dueDate,
                    daysUntil: dueDate - currentDay
                });
            }
        });
    }
    
    // Check loans
    if (yearData.loans) {
        yearData.loans.forEach(loan => {
            const dueDate = parseInt(loan.dueDate);
            if (dueDate >= currentDay && dueDate <= currentDay + daysAhead) {
                upcoming.push({
                    type: 'loan',
                    name: loan.loanPaidTo || 'Loan',
                    dueDate: dueDate,
                    daysUntil: dueDate - currentDay
                });
            }
        });
    }
    
    // Check subscriptions
    if (yearData.subscriptions) {
        const currentMonth = today.getMonth();
        const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                            'July', 'August', 'September', 'October', 'November', 'December'];
        
        yearData.subscriptions.forEach(sub => {
            if (sub.renewal === 'Monthly') {
                const subDay = parseInt(sub.dateOfPayment);
                if (!isNaN(subDay) && subDay >= currentDay && subDay <= currentDay + daysAhead) {
                    upcoming.push({
                        type: 'subscription',
                        name: sub.subscriptionTo,
                        dueDate: subDay,
                        daysUntil: subDay - currentDay
                    });
                }
            } else if (sub.renewal === monthNames[currentMonth]) {
                // Annual subscription in current month
                const subDate = new Date(sub.dateOfPayment);
                const subDay = subDate.getDate();
                if (subDay >= currentDay && subDay <= currentDay + daysAhead) {
                    upcoming.push({
                        type: 'subscription',
                        name: sub.subscriptionTo,
                        dueDate: subDay,
                        daysUntil: subDay - currentDay
                    });
                }
            }
        });
    }
    
    // Sort by days until due
    upcoming.sort((a, b) => a.daysUntil - b.daysUntil);
    
    if (upcoming.length === 0) {
        container.innerHTML = '<p style="color: var(--text-secondary);">No payments due in the next 7 days</p>';
        return;
    }
    
    let html = '<div style="display: flex; flex-direction: column; gap: 0.75rem;">';
    
    upcoming.forEach(item => {
        const icon = item.type === 'credit' ? '💳' : item.type === 'loan' ? '🏦' : '🔄';
        const color = item.daysUntil === 0 ? 'var(--danger)' : 
                      item.daysUntil <= 2 ? 'var(--warning)' : 'var(--text-secondary)';
        const urgency = item.daysUntil === 0 ? 'Due today!' : 
                        item.daysUntil === 1 ? 'Due tomorrow' : 
                        `Due in ${item.daysUntil} days`;
        
        html += `
            <div style="display: flex; justify-content: space-between; align-items: center; 
                        padding: 0.75rem; background: var(--bg-secondary); border-radius: 8px;">
                <div style="display: flex; align-items: center; gap: 0.75rem;">
                    <span style="font-size: 1.5rem;">${icon}</span>
                    <div>
                        <strong>${item.name}</strong>
                        <div style="font-size: 0.85rem; color: var(--text-secondary);">
                            Due on the ${item.dueDate}${getDaySuffix(item.dueDate)}
                        </div>
                    </div>
                </div>
                <span style="color: ${color}; font-weight: 600; font-size: 0.9rem;">
                    ${urgency}
                </span>
            </div>
        `;
    });
    
    html += '</div>';
    container.innerHTML = html;
}

/**
 * Get day suffix (st, nd, rd, th)
 */
function getDaySuffix(day) {
    if (day >= 11 && day <= 13) return 'th';
    switch (day % 10) {
        case 1: return 'st';
        case 2: return 'nd';
        case 3: return 'rd';
        default: return 'th';
    }
}

// Re-render charts when theme changes
const originalToggleTheme = window.toggleTheme;
window.toggleTheme = function() {
    originalToggleTheme();
    
    // Re-render dashboard charts with new theme colors
    if (tracker.currentView === 'dashboard') {
        setTimeout(() => {
            renderDashboard();
        }, 100);
    }
};

console.log('✅ Phase 3: Enhanced Charts Module Loaded');
