// ===================================
// FINANCE TRACKER - PART 2C
// Subscriptions & Calendar View Rendering
// ===================================

// ===================================
// SUBSCRIPTIONS VIEW
// ===================================
function renderSubscriptionsView() {
    const tbody = document.getElementById('subscriptionsTableBody');
    const filter = document.getElementById('subStatusFilter')?.value || 'all';
    
    // Get subscriptions from MASTER list
    const allSubscriptions = tracker.data.subscriptions || [];
    
    // Filter by active dates (subscriptions don't need archive toggle for now, just filter active)
    const activeSubscriptions = getActiveItems(allSubscriptions, tracker.currentYear);
    
    if (activeSubscriptions.length === 0) {
        tbody.innerHTML = `
            <tr>
                <td colspan="10" style="text-align: center; padding: 3rem; color: var(--text-secondary);">
                    <p style="font-size: 1.2rem; margin-bottom: 1rem;">No subscriptions added yet</p>
                    <button class="btn-primary" onclick="addNewSubscription()">+ Add Your First Subscription</button>
                </td>
            </tr>
        `;
        return;
    }

    tbody.innerHTML = '';

    // Group subscriptions by type
    const groups = {
        annual: [],
        monthly: [],
        custom: [],
        discontinued: []
    };

    activeSubscriptions.forEach(sub => {
        const renewal = sub.renewal?.toLowerCase() || 'monthly';
        if (renewal === 'discontinued') {
            groups.discontinued.push(sub);
        } else if (['january', 'february', 'march', 'april', 'may', 'june', 
                    'july', 'august', 'september', 'october', 'november', 'december'].includes(renewal)) {
            groups.annual.push(sub);
        } else if (renewal === 'monthly') {
            groups.monthly.push(sub);
        } else {
            groups.custom.push(sub);
        }
    });

    // Render each group
    const groupOrder = ['annual', 'monthly', 'custom', 'discontinued'];
    const groupLabels = {
        annual: 'ANNUAL',
        monthly: 'MONTHLY',
        custom: 'CUSTOM',
        discontinued: 'DISCONTINUED'
    };

    groupOrder.forEach(groupKey => {
        if (filter !== 'all' && filter !== groupKey) return;
        if (groups[groupKey].length === 0) return;

        // Group header
        const headerRow = document.createElement('tr');
        headerRow.style.background = 'var(--accent-primary)';
        headerRow.style.color = 'white';
        headerRow.style.fontWeight = 'bold';
        headerRow.innerHTML = `<td colspan="10" style="padding: 1rem;">${groupLabels[groupKey]}</td>`;
        tbody.appendChild(headerRow);

        // Subscriptions in this group
        groups[groupKey].forEach((sub, index) => {
            const row = createSubscriptionRow(sub, index);
            tbody.appendChild(row);
        });
    });
}

function createSubscriptionRow(sub, globalIndex) {
    const row = document.createElement('tr');
    
    const purposes = Array.isArray(sub.purpose) ? sub.purpose.join(', ') : (sub.purpose || '');
    
    row.innerHTML = `
        <td>${sub.dateOfPayment || ''}</td>
        <td>${sub.subscriptionTo || ''}</td>
        <td>${sub.renewal || 'Monthly'}</td>
        <td>${purposes}</td>
        <td>${formatCurrency(sub.charge || 0)}</td>
        <td>${formatCurrency(sub.perCycle || 0)}</td>
        <td>${formatCurrency(sub.annualTotal || 0)}</td>
        <td>${formatCurrency(sub.monthlyTotal || 0)}</td>
        <td>${sub.paymentMethod || ''}</td>
        <td>
            <button class="btn-secondary" style="padding: 0.25rem 0.5rem; font-size: 0.8rem;" 
                    onclick="editSubscription(${globalIndex})">Edit</button>
            <button class="btn-danger" style="padding: 0.25rem 0.5rem; font-size: 0.8rem; margin-left: 0.5rem;" 
                    onclick="deleteSubscription(${globalIndex})">Delete</button>
        </td>
    `;
    
    return row;
}

function addNewSubscription() {
    showModal(`
        <h2>Add New Subscription</h2>
        <form id="addSubscriptionForm" style="display: flex; flex-direction: column; gap: 1rem;">
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Subscription Name:</label>
                <input type="text" id="subName" placeholder="e.g., Netflix" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Renewal Frequency:</label>
                <select id="subRenewal" onchange="updateSubscriptionDateField()"
                        style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                               border: 1px solid var(--border-color); background: var(--bg-primary); 
                               color: var(--text-primary);">
                    <option value="Monthly">Monthly</option>
                    <option value="January">January (Annual)</option>
                    <option value="February">February (Annual)</option>
                    <option value="March">March (Annual)</option>
                    <option value="April">April (Annual)</option>
                    <option value="May">May (Annual)</option>
                    <option value="June">June (Annual)</option>
                    <option value="July">July (Annual)</option>
                    <option value="August">August (Annual)</option>
                    <option value="September">September (Annual)</option>
                    <option value="October">October (Annual)</option>
                    <option value="November">November (Annual)</option>
                    <option value="December">December (Annual)</option>
                    <option value="Custom">Custom</option>
                </select>
            </div>
            
            <div id="dateFieldContainer">
                <label style="display: block; margin-bottom: 0.5rem;">Date of Payment:</label>
                <input type="text" id="subDate" placeholder="Day of month (1-31)" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Charge Amount:</label>
                <input type="number" step="0.01" id="subCharge" placeholder="0.00" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Purpose (select up to 2):</label>
                <select id="subPurpose1" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                               border: 1px solid var(--border-color); background: var(--bg-primary); 
                               color: var(--text-primary); margin-bottom: 0.5rem;">
                    <option value="">Select primary purpose...</option>
                    <option value="Entertainment">Entertainment</option>
                    <option value="Financial">Financial</option>
                    <option value="Learning">Learning</option>
                    <option value="Music">Music</option>
                    <option value="Utility">Utility</option>
                    <option value="Work">Work</option>
                </select>
                <select id="subPurpose2" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                               border: 1px solid var(--border-color); background: var(--bg-primary); 
                               color: var(--text-primary);">
                    <option value="">Select secondary purpose (optional)...</option>
                    <option value="Entertainment">Entertainment</option>
                    <option value="Financial">Financial</option>
                    <option value="Learning">Learning</option>
                    <option value="Music">Music</option>
                    <option value="Utility">Utility</option>
                    <option value="Work">Work</option>
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Payment Method:</label>
                <select id="subPaymentMethod" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                               border: 1px solid var(--border-color); background: var(--bg-primary); 
                               color: var(--text-primary);">
                    <option value="Credit Card">Credit Card</option>
                    <option value="Checking Auto-Debit">Checking Auto-Debit</option>
                    <option value="PayPal">PayPal</option>
                    <option value="Manual Renewal">Manual Renewal</option>
                </select>
            </div>
            
            <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                <button type="submit" class="btn-primary">Add Subscription</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">Cancel</button>
            </div>
        </form>
    `);

    document.getElementById('addSubscriptionForm').addEventListener('submit', (e) => {
        e.preventDefault();
        
        const name = document.getElementById('subName').value.trim();
        const renewal = document.getElementById('subRenewal').value;
        const date = document.getElementById('subDate').value.trim();
        const charge = parseFloat(document.getElementById('subCharge').value) || 0;
        const purpose1 = document.getElementById('subPurpose1').value;
        const purpose2 = document.getElementById('subPurpose2').value;
        const paymentMethod = document.getElementById('subPaymentMethod').value;
        
        const purposes = [purpose1, purpose2].filter(p => p);
        
        // Calculate annual and monthly totals
        let annualTotal = 0;
        let monthlyTotal = 0;
        let perCycle = charge;
        
        if (renewal === 'Monthly') {
            annualTotal = charge * 12;
            monthlyTotal = charge;
        } else if (renewal === 'Custom') {
            annualTotal = charge;
            monthlyTotal = charge / 12;
        } else {
            // Annual
            annualTotal = charge;
            monthlyTotal = charge / 12;
        }
        
        const newSub = {
            dateOfPayment: date,
            subscriptionTo: name,
            renewal: renewal,
            purpose: purposes,
            charge: charge,
            perCycle: perCycle,
            annualTotal: annualTotal,
            monthlyTotal: monthlyTotal,
            paymentMethod: paymentMethod,
            discount: 0,
            orderNumber: '',
            registrationNumber: '',
            notes: '',
            link: '',
            email: '',
            id: generateId(),
            startDate: `${tracker.currentYear}-01-01`,
            endDate: null
        };
        
        tracker.saveState();
        // Add to MASTER list
        tracker.data.subscriptions.push(newSub);
        
        renderSubscriptionsView();
        closeModal();
        showToast('Subscription added!', 'success');
    });
}

function updateSubscriptionDateField() {
    const renewal = document.getElementById('subRenewal').value;
    const container = document.getElementById('dateFieldContainer');
    
    if (renewal === 'Monthly') {
        container.innerHTML = `
            <label style="display: block; margin-bottom: 0.5rem;">Date of Payment:</label>
            <input type="text" id="subDate" placeholder="Day of month (1-31)" required
                   style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                          border: 1px solid var(--border-color); background: var(--bg-primary); 
                          color: var(--text-primary);">
        `;
    } else if (renewal === 'Custom') {
        container.innerHTML = `
            <label style="display: block; margin-bottom: 0.5rem;">Date of Payment:</label>
            <input type="date" id="subDate" required
                   style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                          border: 1px solid var(--border-color); background: var(--bg-primary); 
                          color: var(--text-primary);">
        `;
    } else {
        // Annual
        container.innerHTML = `
            <label style="display: block; margin-bottom: 0.5rem;">Date of Payment:</label>
            <input type="date" id="subDate" required
                   style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                          border: 1px solid var(--border-color); background: var(--bg-primary); 
                          color: var(--text-primary);">
        `;
    }
}

function editSubscription(index) {
    const yearData = tracker.getYearData();
    const sub = yearData.subscriptions[index];
    
    if (!sub) {
        showToast('Subscription not found', 'error');
        return;
    }
    
    const purposes = Array.isArray(sub.purpose) ? sub.purpose : [sub.purpose];
    const purpose1 = purposes[0] || '';
    const purpose2 = purposes[1] || '';
    
    showModal(`
        <h2>Edit Subscription</h2>
        <form id="editSubscriptionForm" style="display: flex; flex-direction: column; gap: 1rem;">
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Subscription Name:</label>
                <input type="text" id="editSubName" value="${sub.subscriptionTo || ''}" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Renewal Frequency:</label>
                <select id="editSubRenewal" onchange="updateEditSubscriptionDateField()"
                        style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                               border: 1px solid var(--border-color); background: var(--bg-primary); 
                               color: var(--text-primary);">
                    <option value="Monthly" ${sub.renewal === 'Monthly' ? 'selected' : ''}>Monthly</option>
                    <option value="January" ${sub.renewal === 'January' ? 'selected' : ''}>January (Annual)</option>
                    <option value="February" ${sub.renewal === 'February' ? 'selected' : ''}>February (Annual)</option>
                    <option value="March" ${sub.renewal === 'March' ? 'selected' : ''}>March (Annual)</option>
                    <option value="April" ${sub.renewal === 'April' ? 'selected' : ''}>April (Annual)</option>
                    <option value="May" ${sub.renewal === 'May' ? 'selected' : ''}>May (Annual)</option>
                    <option value="June" ${sub.renewal === 'June' ? 'selected' : ''}>June (Annual)</option>
                    <option value="July" ${sub.renewal === 'July' ? 'selected' : ''}>July (Annual)</option>
                    <option value="August" ${sub.renewal === 'August' ? 'selected' : ''}>August (Annual)</option>
                    <option value="September" ${sub.renewal === 'September' ? 'selected' : ''}>September (Annual)</option>
                    <option value="October" ${sub.renewal === 'October' ? 'selected' : ''}>October (Annual)</option>
                    <option value="November" ${sub.renewal === 'November' ? 'selected' : ''}>November (Annual)</option>
                    <option value="December" ${sub.renewal === 'December' ? 'selected' : ''}>December (Annual)</option>
                    <option value="Custom" ${sub.renewal === 'Custom' ? 'selected' : ''}>Custom</option>
                    <option value="Discontinued" ${sub.renewal === 'Discontinued' ? 'selected' : ''}>Discontinued</option>
                </select>
            </div>
            
            <div id="editDateFieldContainer">
                <label style="display: block; margin-bottom: 0.5rem;">Date of Payment:</label>
                <input type="text" id="editSubDate" value="${sub.dateOfPayment || ''}" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Charge Amount:</label>
                <input type="number" step="0.01" id="editSubCharge" value="${sub.charge || 0}" required
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Discount (optional):</label>
                <input type="number" step="0.01" id="editSubDiscount" value="${sub.discount || 0}"
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Purpose (select up to 2):</label>
                <select id="editSubPurpose1" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                               border: 1px solid var(--border-color); background: var(--bg-primary); 
                               color: var(--text-primary); margin-bottom: 0.5rem;">
                    <option value="">Select primary purpose...</option>
                    <option value="Entertainment" ${purpose1 === 'Entertainment' ? 'selected' : ''}>Entertainment</option>
                    <option value="Financial" ${purpose1 === 'Financial' ? 'selected' : ''}>Financial</option>
                    <option value="Learning" ${purpose1 === 'Learning' ? 'selected' : ''}>Learning</option>
                    <option value="Music" ${purpose1 === 'Music' ? 'selected' : ''}>Music</option>
                    <option value="Utility" ${purpose1 === 'Utility' ? 'selected' : ''}>Utility</option>
                    <option value="Work" ${purpose1 === 'Work' ? 'selected' : ''}>Work</option>
                </select>
                <select id="editSubPurpose2" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                               border: 1px solid var(--border-color); background: var(--bg-primary); 
                               color: var(--text-primary);">
                    <option value="">Select secondary purpose (optional)...</option>
                    <option value="Entertainment" ${purpose2 === 'Entertainment' ? 'selected' : ''}>Entertainment</option>
                    <option value="Financial" ${purpose2 === 'Financial' ? 'selected' : ''}>Financial</option>
                    <option value="Learning" ${purpose2 === 'Learning' ? 'selected' : ''}>Learning</option>
                    <option value="Music" ${purpose2 === 'Music' ? 'selected' : ''}>Music</option>
                    <option value="Utility" ${purpose2 === 'Utility' ? 'selected' : ''}>Utility</option>
                    <option value="Work" ${purpose2 === 'Work' ? 'selected' : ''}>Work</option>
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Payment Method:</label>
                <select id="editSubPaymentMethod" style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                               border: 1px solid var(--border-color); background: var(--bg-primary); 
                               color: var(--text-primary);">
                    <option value="Credit Card" ${sub.paymentMethod === 'Credit Card' ? 'selected' : ''}>Credit Card</option>
                    <option value="Checking Auto-Debit" ${sub.paymentMethod === 'Checking Auto-Debit' ? 'selected' : ''}>Checking Auto-Debit</option>
                    <option value="PayPal" ${sub.paymentMethod === 'PayPal' ? 'selected' : ''}>PayPal</option>
                    <option value="Manual Renewal" ${sub.paymentMethod === 'Manual Renewal' ? 'selected' : ''}>Manual Renewal</option>
                </select>
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Order/Invoice #:</label>
                <input type="text" id="editSubOrderNumber" value="${sub.orderNumber || ''}"
                       placeholder="Optional"
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Registration #:</label>
                <input type="text" id="editSubRegistrationNumber" value="${sub.registrationNumber || ''}"
                       placeholder="Optional"
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Link to Subscription Site:</label>
                <input type="url" id="editSubLink" value="${sub.link || ''}"
                       placeholder="https://..."
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Email:</label>
                <input type="email" id="editSubEmail" value="${sub.email || ''}"
                       placeholder="account@email.com"
                       style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                              border: 1px solid var(--border-color); background: var(--bg-primary); 
                              color: var(--text-primary);">
            </div>
            
            <div>
                <label style="display: block; margin-bottom: 0.5rem;">Notes:</label>
                <textarea id="editSubNotes" 
                          style="width: 100%; min-height: 80px; padding: 0.75rem; border-radius: 8px; 
                                 border: 1px solid var(--border-color); background: var(--bg-primary); 
                                 color: var(--text-primary); resize: vertical;">${sub.notes || ''}</textarea>
            </div>
            
            <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                <button type="submit" class="btn-primary">Save Changes</button>
                <button type="button" class="btn-secondary" onclick="closeModal()">Cancel</button>
            </div>
        </form>
    `);

    // Set up the date field based on current renewal type
    updateEditSubscriptionDateField();

    document.getElementById('editSubscriptionForm').addEventListener('submit', (e) => {
        e.preventDefault();
        
        const name = document.getElementById('editSubName').value.trim();
        const renewal = document.getElementById('editSubRenewal').value;
        const date = document.getElementById('editSubDate').value.trim();
        const charge = parseFloat(document.getElementById('editSubCharge').value) || 0;
        const discount = parseFloat(document.getElementById('editSubDiscount').value) || 0;
        const purpose1 = document.getElementById('editSubPurpose1').value;
        const purpose2 = document.getElementById('editSubPurpose2').value;
        const paymentMethod = document.getElementById('editSubPaymentMethod').value;
        const orderNumber = document.getElementById('editSubOrderNumber').value.trim();
        const registrationNumber = document.getElementById('editSubRegistrationNumber').value.trim();
        const link = document.getElementById('editSubLink').value.trim();
        const email = document.getElementById('editSubEmail').value.trim();
        const notes = document.getElementById('editSubNotes').value.trim();
        
        const purposes = [purpose1, purpose2].filter(p => p);
        
        // Calculate annual and monthly totals
        let annualTotal = 0;
        let monthlyTotal = 0;
        let perCycle = charge - discount;
        
        if (renewal === 'Monthly') {
            annualTotal = perCycle * 12;
            monthlyTotal = perCycle;
        } else if (renewal === 'Custom') {
            annualTotal = perCycle;
            monthlyTotal = perCycle / 12;
        } else if (renewal === 'Discontinued') {
            annualTotal = 0;
            monthlyTotal = 0;
        } else {
            // Annual
            annualTotal = perCycle;
            monthlyTotal = perCycle / 12;
        }
        
        tracker.saveState();
        
        yearData.subscriptions[index] = {
            dateOfPayment: date,
            subscriptionTo: name,
            renewal: renewal,
            purpose: purposes,
            charge: charge,
            perCycle: perCycle,
            discount: discount,
            annualTotal: annualTotal,
            monthlyTotal: monthlyTotal,
            paymentMethod: paymentMethod,
            orderNumber: orderNumber,
            registrationNumber: registrationNumber,
            link: link,
            email: email,
            notes: notes
        };
        
        // Recalculate monthly totals since subscription changed
        recalculateMonthlyFromSources();
        
        renderSubscriptionsView();
        
        if (tracker.currentView === 'monthly') {
            renderMonthlyView();
        }
        
        closeModal();
        showToast('Subscription updated!', 'success');
    });
}

function updateEditSubscriptionDateField() {
    const renewal = document.getElementById('editSubRenewal').value;
    const container = document.getElementById('editDateFieldContainer');
    const currentValue = document.getElementById('editSubDate')?.value || '';
    
    if (renewal === 'Monthly') {
        container.innerHTML = `
            <label style="display: block; margin-bottom: 0.5rem;">Date of Payment:</label>
            <input type="text" id="editSubDate" value="${currentValue}" placeholder="Day of month (1-31)" required
                   style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                          border: 1px solid var(--border-color); background: var(--bg-primary); 
                          color: var(--text-primary);">
            <small style="color: var(--text-secondary);">Enter the day of month (e.g., 15 for the 15th)</small>
        `;
    } else if (renewal === 'Custom' || renewal === 'Discontinued') {
        container.innerHTML = `
            <label style="display: block; margin-bottom: 0.5rem;">Date of Payment:</label>
            <input type="date" id="editSubDate" value="${currentValue}" required
                   style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                          border: 1px solid var(--border-color); background: var(--bg-primary); 
                          color: var(--text-primary);">
        `;
    } else {
        // Annual
        container.innerHTML = `
            <label style="display: block; margin-bottom: 0.5rem;">Date of Payment:</label>
            <input type="date" id="editSubDate" value="${currentValue}" required
                   style="width: 100%; padding: 0.75rem; border-radius: 8px; 
                          border: 1px solid var(--border-color); background: var(--bg-primary); 
                          color: var(--text-primary);">
            <small style="color: var(--text-secondary);">Will charge once in ${renewal}</small>
        `;
    }
}

function deleteSubscription(index) {
    if (!confirm('Are you sure you want to delete this subscription?')) return;
    
    const yearData = tracker.getYearData();
    tracker.saveState();
    yearData.subscriptions.splice(index, 1);
    renderSubscriptionsView();
    showToast('Subscription deleted', 'success');
}

// ===================================
// CALENDAR VIEW
// ===================================
let calendarCurrentDate = new Date();

function renderCalendar() {
    const year = calendarCurrentDate.getFullYear();
    const month = calendarCurrentDate.getMonth();
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                        'July', 'August', 'September', 'October', 'November', 'December'];
    
    document.getElementById('calendarMonth').textContent = `${monthNames[month]} ${year}`;
    
    const grid = document.getElementById('calendarGrid');
    grid.innerHTML = '';
    
    // Add day headers
    const dayHeaders = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    dayHeaders.forEach(day => {
        const header = document.createElement('div');
        header.style.padding = '0.5rem';
        header.style.fontWeight = 'bold';
        header.style.textAlign = 'center';
        header.style.background = 'var(--bg-secondary)';
        header.textContent = day;
        grid.appendChild(header);
    });
    
    // Get first day of month and number of days
    const firstDay = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const daysInPrevMonth = new Date(year, month, 0).getDate();
    
    // Add previous month's days
    for (let i = firstDay - 1; i >= 0; i--) {
        const day = createCalendarDay(daysInPrevMonth - i, true);
        grid.appendChild(day);
    }
    
    // Add current month's days
    const today = new Date();
    for (let i = 1; i <= daysInMonth; i++) {
        const isToday = year === today.getFullYear() && 
                        month === today.getMonth() && 
                        i === today.getDate();
        const day = createCalendarDay(i, false, isToday);
        
        // Add events for this day
        addCalendarEvents(day, year, month, i);
        
        grid.appendChild(day);
    }
    
    // Add next month's days to fill grid
    const totalCells = grid.children.length - 7; // Subtract day headers
    const remainingCells = 35 - totalCells; // 5 weeks * 7 days
    for (let i = 1; i <= remainingCells; i++) {
        const day = createCalendarDay(i, true);
        grid.appendChild(day);
    }
}

function createCalendarDay(dayNumber, isOtherMonth = false, isToday = false) {
    const day = document.createElement('div');
    day.className = 'calendar-day';
    if (isOtherMonth) day.classList.add('other-month');
    if (isToday) day.classList.add('today');
    
    const dayNum = document.createElement('div');
    dayNum.className = 'day-number';
    dayNum.textContent = dayNumber;
    day.appendChild(dayNum);
    
    return day;
}

function addCalendarEvents(dayElement, year, month, day) {
    const yearData = tracker.getYearData(year);
    const monthKey = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'][month];
    
    // Check credit card due dates
    if (yearData.credit) {
        yearData.credit.forEach(card => {
            if (card.dueDate == day) {
                const event = document.createElement('div');
                event.className = 'calendar-event credit';
                event.textContent = `💳 ${card.name || 'Credit'} due`;
                event.onclick = () => showEventDetails('credit', card);
                dayElement.appendChild(event);
            }
        });
    }
    
    // Check loan due dates
    if (yearData.loans) {
        yearData.loans.forEach(loan => {
            if (loan.dueDate == day) {
                const event = document.createElement('div');
                event.className = 'calendar-event loan';
                event.textContent = `🏦 ${loan.loanPaidTo || 'Loan'} due`;
                event.onclick = () => showEventDetails('loan', loan);
                dayElement.appendChild(event);
            }
        });
    }
    
    // Check subscription renewals
    if (yearData.subscriptions) {
        yearData.subscriptions.forEach(sub => {
            let showEvent = false;
            
            if (sub.renewal === 'Monthly' && sub.dateOfPayment == day) {
                showEvent = true;
            } else if (sub.renewal && sub.renewal !== 'Monthly' && sub.renewal !== 'Custom') {
                // Annual subscription
                const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 
                                    'July', 'August', 'September', 'October', 'November', 'December'];
                if (monthNames[month] === sub.renewal) {
                    const subDate = parseInt(sub.dateOfPayment);
                    if (subDate === day) {
                        showEvent = true;
                    }
                }
            }
            
            if (showEvent) {
                const event = document.createElement('div');
                event.className = 'calendar-event subscription';
                event.textContent = `🔄 ${sub.subscriptionTo}`;
                event.onclick = () => showEventDetails('subscription', sub);
                dayElement.appendChild(event);
            }
        });
    }
}

function showEventDetails(type, data) {
    let content = `<h2>${type.charAt(0).toUpperCase() + type.slice(1)} Details</h2>`;
    
    if (type === 'credit') {
        content += `
            <p><strong>Card:</strong> ${data.name}</p>
            <p><strong>Type:</strong> ${data.type}</p>
            <p><strong>Limit:</strong> ${formatCurrency(data.limit)}</p>
            <p><strong>Due Date:</strong> Day ${data.dueDate} of each month</p>
        `;
    } else if (type === 'loan') {
        content += `
            <p><strong>Loan:</strong> ${data.loanPaidTo}</p>
            <p><strong>Lender:</strong> ${data.loanLender}</p>
            <p><strong>Regular Payment:</strong> ${formatCurrency(data.regularPayment)}</p>
            <p><strong>Due Date:</strong> Day ${data.dueDate} of each month</p>
        `;
    } else if (type === 'subscription') {
        content += `
            <p><strong>Subscription:</strong> ${data.subscriptionTo}</p>
            <p><strong>Renewal:</strong> ${data.renewal}</p>
            <p><strong>Charge:</strong> ${formatCurrency(data.charge)}</p>
            <p><strong>Payment Method:</strong> ${data.paymentMethod}</p>
        `;
    }
    
    content += '<button class="btn-secondary" onclick="closeModal()" style="margin-top: 1rem;">Close</button>';
    showModal(content);
}

function navigateCalendar(delta) {
    calendarCurrentDate.setMonth(calendarCurrentDate.getMonth() + delta);
    renderCalendar();
}

function goToToday() {
    calendarCurrentDate = new Date();
    renderCalendar();
}

// Calendar controls
document.getElementById('calPrevMonth')?.addEventListener('click', () => navigateCalendar(-1));
document.getElementById('calNextMonth')?.addEventListener('click', () => navigateCalendar(1));
document.getElementById('calToday')?.addEventListener('click', goToToday);

// Subscription filter
document.getElementById('subStatusFilter')?.addEventListener('change', renderSubscriptionsView);

// Add subscription button
document.getElementById('addSubscription')?.addEventListener('click', addNewSubscription);
