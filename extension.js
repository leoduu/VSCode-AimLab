// extension.js
const vscode = require('vscode');

// 激活插件
function activate(context) {
    // 注册配置改变事件监听器
    let configDisposable = vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('aimBot')) {
            vscode.window.showInformationMessage('测试配置已更新');
        }
    });

    let disposable = vscode.commands.registerCommand('aimBot.start', function () {
        // 获取当前活动编辑器
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            vscode.window.showErrorMessage('请先打开一个编辑器窗口');
            return;
        }

        // 开始测试
        new AimBotTest(editor).run();
    });

    context.subscriptions.push(disposable, configDisposable);
}

class AimBotTest {
    constructor(editor) {
        this.editor = editor;

        // 从配置获取参数
        const config = vscode.workspace.getConfiguration('aimBot');
        this.totalTests = config.get('testCount', 10);
        this.timeoutMs = config.get('timeoutMs', 1000);
        this.difficulty = config.get('difficulty', 2);
        this.intervalMs = config.get('intervalMs', 500);

        this.currentTest = 0;
        this.clickTimes = [];
        this.successfulClicks = 0;
        this.failedClicks = 0;
        this.timeoutCount = 0;
        this.currentDecoration = null;
        this.startTime = 0;
        this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        this.isRunning = false;
        this.originalContent = null;
        this.visibleRange = null;

        // 定义装饰样式
        this.highlightDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 200, 0, 0.5)',
            border: '2px solid rgba(255, 150, 0, 0.8)',
            borderRadius: '3px',
            cursor: 'pointer'
        });

        this.clickedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(0, 255, 0, 0.5)',
            border: '2px solid rgba(0, 200, 0, 0.8)',
            borderRadius: '3px'
        });
        this.failedDecoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: 'rgba(255, 0, 0, 0.5)',
            border: '2px solid rgba(200, 0, 0, 0.8)',
            borderRadius: '3px'
        });
    }

    // 运行测试
    async run() {
        if (this.isRunning) {
            vscode.window.showInformationMessage('测试已在运行中');
            return;
        }

        this.isRunning = true;

        // 显示3秒倒计时开始通知
        vscode.window.showInformationMessage('AimBot将在3秒后开始...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        vscode.window.showInformationMessage('AimBot将在2秒后开始...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        vscode.window.showInformationMessage('AimBot将在1秒后开始...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        vscode.window.showInformationMessage('AimBot开始!');

        // 重置统计信息
        this.clickTimes = [];
        this.successfulClicks = 0;
        this.failedClicks = 0;
        this.timeoutCount = 0;

        // 保存原始内容
        this.originalContent = this.editor.document.getText();

        // 获取当前可见范围
        this.visibleRange = this.editor.visibleRanges[0];
        if (!this.visibleRange) {
            vscode.window.showErrorMessage('无法获取可见范围');
            this.isRunning = false;
            return;
        }

        // 规范化可见区域内容
        await this.normalizeVisibleArea();

        // 显示状态栏信息
        this.updateStatusBar();
        this.statusBarItem.show();

        // 订阅鼠标点击事件
        this.mouseDisposable = vscode.window.onDidChangeTextEditorSelection(this.handleMouseClick.bind(this));

        // 开始测试循环
        for (this.currentTest = 0; this.currentTest < this.totalTests; this.currentTest++) {
            await this.runSingleTest();

            // 更新状态栏
            this.updateStatusBar();

            // 测试间暂停
            if (this.currentTest < this.totalTests - 1) {
                await new Promise(resolve => setTimeout(resolve, this.intervalMs));
            }
        }

        // 测试完成，显示详细统计信息
        this.showFinalStatistics();

        // 恢复原始内容
        await this.restoreOriginalContent();

        // 清理
        this.cleanup();
        this.isRunning = false;
    }

    // 更新状态栏信息
    updateStatusBar() {
        const average = this.clickTimes.length > 0 ?
            this.clickTimes.reduce((a, b) => a + b, 0) / this.clickTimes.length : 0;
        const hitRate = this.currentTest > 0 ? (this.successfulClicks / this.currentTest * 100) : 0;
        const accuracy = (this.successfulClicks + this.failedClicks) > 0 ?
            (this.successfulClicks / (this.successfulClicks + this.failedClicks) * 100) : 0;

        this.statusBarItem.text = `AimBot:${this.currentTest}/${this.totalTests} ✓:${this.successfulClicks} ✗:${this.failedClicks} ⏱:${this.timeoutCount} Avg:${average.toFixed(0)}ms HitRate:${hitRate.toFixed(1)}%`;
    }

    showFinalStatistics() {
        const average = this.clickTimes.length > 0 ?
            this.clickTimes.reduce((a, b) => a + b, 0) / this.clickTimes.length : 0;
        const hitRate = this.totalTests > 0 ? (this.successfulClicks / this.totalTests * 100) : 0;
        const accuracy = (this.successfulClicks + this.failedClicks) > 0 ?
            (this.successfulClicks / (this.successfulClicks + this.failedClicks) * 100) : 0;

        // 创建统计信息消息
        const statsMessage = `Finish!
                            TotalCount: ${this.totalTests}
                            Hit: ${this.successfulClicks}
                            Miss: ${this.failedClicks}
                            TimeoutCnt ${this.timeoutCount}
                            HitRate: ${hitRate.toFixed(1)}%
                            Accuracy: ${accuracy.toFixed(1)}%
                            Avg: ${average.toFixed(0)}ms
                            Fastest: ${this.clickTimes.length > 0 ? Math.min(...this.clickTimes) : 0}ms
                            Slowest: ${this.clickTimes.length > 0 ? Math.max(...this.clickTimes) : 0}ms`;

        vscode.window.showInformationMessage(statsMessage);
    }

    // 规范化可见区域内容
    async normalizeVisibleArea() {
        const document = this.editor.document;
        const startLine = this.visibleRange.start.line + 2;
        const endLine = this.visibleRange.end.line;

        // 获取可见区域的行
        const lines = [];
        for (let i = startLine; i <= endLine; i++) {
            if (i < document.lineCount) {
                lines.push(document.lineAt(i).text);
            } else {
                lines.push('');
            }
        }

        // 找到最长行的长度
        let maxLength = 0;
        for (const line of lines) {
            if (line.length > maxLength) {
                maxLength = line.length;
            }
        }

        // 确保最小长度至少为 100 个字符
        maxLength = Math.max(maxLength, 150);

        // 确保所有行长度相同，用空格填充
        const normalizedLines = lines.map(line => {
            return line + ' '.repeat(maxLength - line.length);
        });

        // 应用规范化内容到可见区域
        const edit = new vscode.WorkspaceEdit();

        // 替换可见区域的内容
        for (let i = 0; i < normalizedLines.length; i++) {
            const lineNum = startLine + i;
            if (lineNum < document.lineCount) {
                const lineRange = new vscode.Range(
                    lineNum, 0,
                    lineNum, document.lineAt(lineNum).text.length
                );
                edit.replace(document.uri, lineRange, normalizedLines[i]);
            } else {
                // 如果行不存在，添加新行
                const position = new vscode.Position(lineNum, 0);
                edit.insert(document.uri, position, normalizedLines[i] + '\n');
            }
        }

        await vscode.workspace.applyEdit(edit);
        await document.save();

        // 更新可见范围
        this.visibleRange = this.editor.visibleRanges[0];
    }

    // 恢复原始内容
    async restoreOriginalContent() {
        const document = this.editor.document;
        const edit = new vscode.WorkspaceEdit();
        const fullRange = new vscode.Range(
            document.positionAt(0),
            document.positionAt(document.getText().length)
        );

        edit.replace(document.uri, fullRange, this.originalContent);
        await vscode.workspace.applyEdit(edit);
        await document.save();
    }

    // 运行单次测试
    async runSingleTest() {
        // 清除之前的装饰
        if (this.currentDecoration) {
            this.editor.setDecorations(this.currentDecoration, []);
        }

        // 获取当前可见范围
        const visibleRange = this.editor.visibleRanges[0];
        if (!visibleRange) {
            vscode.window.showErrorMessage('无法获取可见范围');
            return;
        }

        const startVisibleLine = visibleRange.start.line + 2;
        const endVisibleLine = visibleRange.end.line;

        // 确保有足够的可见行
        if (endVisibleLine - startVisibleLine < this.difficulty) {
            vscode.window.showErrorMessage('可见行数不足，无法进行测试');
            return;
        }

        // 生成随机位置（只在可见范围内）
        const document = this.editor.document;

        let validPositionFound = false;
        let startLine, startChar, range;

        // 尝试找到有效位置
        for (let attempts = 0; attempts < 10; attempts++) {
            startLine = Math.floor(Math.random() * (endVisibleLine - startVisibleLine + 1)) + startVisibleLine;

            // 确保选择的行在文档范围内
            if (startLine >= document.lineCount) {
                continue;
            }

            const line = document.lineAt(startLine);
            const maxChar = Math.max(0, line.text.length - this.difficulty);

            if (maxChar > 0) {
                startChar = Math.floor(Math.random() * maxChar);

                // 判断是否为中文字符（Unicode范围）
                const isChinese = /[\u4e00-\u9fa5]/.test(line.text[startChar]);
                if (isChinese) {
                    break;
                }

                validPositionFound = true;
                // 创建高亮块
                range = new vscode.Range(
                    startLine, startChar,
                    startLine, startChar + this.difficulty
                );
                break;
            }
        }

        if (!validPositionFound) {
            vscode.window.showErrorMessage('无法找到有效位置进行测试');
            return;
        }

        // 应用装饰
        this.editor.setDecorations(this.highlightDecoration, [range]);
        this.currentDecoration = this.highlightDecoration;
        this.targetRange = range;

        // 记录开始时间
        this.startTime = Date.now();
        this.clicked = false;

        // 等待点击或超时
        return new Promise((resolve) => {
            this.resolveTest = resolve;
            this.timeoutId = setTimeout(() => {
                if (!this.clicked) {
                    this.clicked = true;
                    this.timeoutCount++;
                    vscode.window.showWarningMessage(`timeout (${this.timeoutMs}ms)`);
                    // 清除当前的高亮块
                    if (this.currentDecoration) {
                        this.editor.setDecorations(this.currentDecoration, []);
                    }
                    this.resolveTest();
                }
            }, this.timeoutMs);
        });
    }

    // 处理鼠标点击事件
    handleMouseClick(event) {
        if (event.textEditor !== this.editor || !this.targetRange || this.clicked || !this.isRunning) {
            return;
        }

        // 检查选择是否在目标范围内
        const selection = event.selections[0];
        if (selection) {
            if (this.targetRange.contains(selection.active)) {
                // 成功点击高亮块
                this.clicked = true;

                // 清除超时计时器
                if (this.timeoutId) {
                    clearTimeout(this.timeoutId);
                }

                // 计算反应时间
                const aimBotTime = Date.now() - this.startTime;
                this.clickTimes.push(aimBotTime);
                this.successfulClicks++;

                // 改变装饰样式
                this.editor.setDecorations(this.clickedDecoration, [this.targetRange]);
                this.currentDecoration = this.clickedDecoration;

                // 显示反应时间
                vscode.window.showInformationMessage(`ClickedTime: ${aimBotTime}ms`);

                // 解决当前测试的Promise
                if (this.resolveTest) {
                    this.resolveTest();
                }
            } else {
                this.clicked = true;
                // 点击了但不在高亮块范围内（未命中）
                this.failedClicks++;

                // 改变装饰样式为红色
                this.editor.setDecorations(this.failedDecoration, [this.targetRange]);
                this.currentDecoration = this.failedDecoration;

                // 显示失败信息
                vscode.window.showWarningMessage('miss!');

                // 清除超时计时器
                if (this.timeoutId) {
                    clearTimeout(this.timeoutId);
                }

                // 延迟后继续下一次测试
                setTimeout(() => {
                    if (this.resolveTest) {
                        this.resolveTest();
                    }
                }, this.intervalMs);
            }
        }
    }

    // 清理资源
    cleanup() {
        if (this.mouseDisposable) {
            this.mouseDisposable.dispose();
        }

        if (this.currentDecoration) {
            this.editor.setDecorations(this.currentDecoration, []);
        }

        if (this.timeoutId) {
            clearTimeout(this.timeoutId);
        }

        this.statusBarItem.hide();
        this.statusBarItem.dispose();
        this.highlightDecoration.dispose();
        this.clickedDecoration.dispose();
        this.failedDecoration.dispose();
    }
}

// 停用插件
function deactivate() {
    // 清理工作
}

module.exports = {
    activate,
    deactivate
};