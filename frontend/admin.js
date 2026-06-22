if (typeof API_BASE_URL === 'undefined') {
    window.API_BASE_URL = 'http://localhost:3000/api';
}

window.togglePollStatus = async function(pollId) {
    try {
        const response = await fetch(`${window.location.origin}/api/polls/${pollId}/toggle`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' }
        });
        const result = await response.json();
        if (result.success) {
            loadAdminPollsList();
        } else {
            alert('Ошибка: ' + result.error);
        }
    } catch (e) {
        console.error(e);
        alert('Техническая ошибка');
    }
};

window.deletePoll = async function(pollId) {
    if (!confirm(`Вы действительно хотите удалить опрос #${pollId}?`)) return;
    try {
        const url = `${window.location.origin}/api/polls/${pollId}`;
        const response = await fetch(url, {
            method: 'DELETE',
            headers: { 'Content-Type': 'application/json' }
        });
        if (response.status === 404) {
            alert("Ошибка 404: путь для удаления не найден");
            return;
        }
        const result = await response.json();
        if (result.success) {
            loadAdminPollsList();
        } else {
            alert("Ошибка: " + result.error);
        }
    } catch (e) {
        console.error(e);
        alert("Техническая ошибка при удалении");
    }
};

function startPollCreation(user) {
    const question = prompt("Введите вопрос для опроса:");
    if (!question) return;

    let options = [];
    let i = 1;
    while (true) {
        let opt = prompt(`Вариант ответа #${i} (оставьте пустым для завершения):`);
        if (!opt || opt.trim() === "") break;
        options.push(opt.trim());
        i++;
    }

    if (options.length < 2) {
        alert("Необходимо минимум 2 варианта ответа");
        return;
    }

    sendPollToServer(user.id, question, options);
}

async function sendPollToServer(userId, question, options) {
    try {
        const response = await fetch('/api/polls', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                userId: userId || 1,
                question: question,
                options: options
            })
        });
        if (response.status === 404) {
            console.error("Маршрут /api/polls не найден");
            return;
        }
        const result = await response.json();
        if (result.success) {
            loadAdminPollsList();
        } else {
            alert("Ошибка: " + result.error);
        }
    } catch (e) {
        console.error("Ошибка при отправке:", e);
    }
}

async function loadAdminPollsList() {
    const listContainer = document.getElementById('adminPollsList');
    if (!listContainer) return;

    const apiUrl = window.location.origin + '/api/polls/admin-list';

    try {
        const res = await fetch(apiUrl);
        if (!res.ok) throw new Error('Ошибка сети: ' + res.status);

        const contentType = res.headers.get("content-type");
        if (!contentType || !contentType.includes("application/json")) {
            listContainer.innerHTML = '<div style="color:red">Ошибка: сервер вернул некорректные данные</div>';
            return;
        }

        const data = await res.json();

        if (data.success && data.polls) {
            listContainer.innerHTML = data.polls.map(p => `
                <div class="admin-poll-card" style="border:1px solid #444; margin:10px 0; padding:15px; border-radius:8px; background:#222;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>#${p.id}: ${p.question}</strong>
                            <span style="margin-left:10px; font-size:12px; padding:2px 8px; border-radius:4px; ${p.is_active ? 'background:#28a745;color:#fff' : 'background:#6c757d;color:#fff'}">
                                ${p.is_active ? 'Активен' : 'Неактивен'}
                            </span>
                        </div>
                        <div style="display:flex; gap:6px;">
                            <button onclick="togglePollStatus(${p.id})" style="background:${p.is_active ? '#ffc107' : '#28a745'}; color:white; border:none; padding:5px 10px; cursor:pointer; border-radius:4px; font-size:13px;">
                                <i class="fas ${p.is_active ? 'fa-pause' : 'fa-play'}"></i> ${p.is_active ? 'Выкл' : 'Вкл'}
                            </button>
                            <button onclick="deletePoll(${p.id})" style="background:#ff4444; color:white; border:none; padding:5px 10px; cursor:pointer; border-radius:4px; font-size:13px;">
                                <i class="fas fa-trash"></i>
                            </button>
                        </div>
                    </div>
                </div>
            `).join('');
        } else {
            listContainer.innerHTML = '<div style="color:#aaa">Список опросов пуст</div>';
        }
    } catch (e) {
        console.error("Ошибка загрузки списка:", e);
        listContainer.innerHTML = `<div style="color:red">Ошибка: ${e.message}</div>`;
    }
}
