(() => {
  'use strict';

  const TAG = '함수 쓰임 확프:';
  const VARIABLE_BLOCK_TYPES = new Set([
    'get_variable',
    'set_variable',
    'change_variable',
    'add_value_to_list',
    'is_included_in_list',
    'length_of_list',
    'show_list',
    'hide_list',
    'show_variable',
    'hide_variable',
    'remove_value_from_list',
    'insert_value_to_list',
    'change_value_list_index',
  ]);

  function ready() {
    return window.Entry && Entry.variableContainer && Entry.Code && Entry.Code.prototype && Entry.Func;
  }

  function installWhenReady(retry = 0) {
    if (ready()) return install();
    if (retry > 120) return console.warn(TAG, 'Entry 준비 대기 실패');
    setTimeout(() => installWhenReady(retry + 1), 250);
  }

  function install() {
    const vc = Entry.variableContainer;
    if (!vc) return console.warn(TAG, 'Entry.variableContainer가 없습니다.');

    if (Entry.__functionVariableRefPatchInstalled) {
      console.warn(TAG, '이미 적용되어 있습니다. 다시 스캔합니다.');
      Entry.__functionVariableRefPatchRescan?.();
      return;
    }

    Entry.__functionVariableRefPatchInstalled = true;

    injectStyle();
    patchModeForAddRef();
    patchRenderVariableReference();
    patchRenderMessageReferenceForFuncFlag();
    patchRescanTriggers();
    installCommandDoProxyScanWatcher();

    Entry.__functionVariableRefPatchRescan = rescanAllRefs;

    // 초기 1회만 스캔. 이후에는 updateList마다 반복하지 않음.
    setTimeout(rescanAllRefs, 300);
    console.log(TAG, '설치 완료');
  }

  function injectStyle() {
    if (document.getElementById('entry-function-variable-ref-style')) return;

    const style = document.createElement('style');
    style.id = 'entry-function-variable-ref-style';
    style.textContent = `
      .entryFuncVariableRef,
      .entryFuncMessageRef {
        position: relative;
        white-space: nowrap;
      }

      .entryFuncVariableRef .entryFuncRefBadge,
      .entryFuncMessageRef .entryFuncRefBadge {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        box-sizing: border-box;
        height: 14px;
        min-width: 24px;
        margin-right: 5px;
        padding: 0 5px;
        border-radius: 8px;
        font-size: 10px;
        line-height: 1;
        background: #7c3aed;
        color: #fff;
        vertical-align: middle;
        position: relative;
        top: -3px;
      }

      .entryFuncVariableRef .text,
      .entryFuncMessageRef .text {
        font-weight: 600;
        vertical-align: middle;
      }
    `;
    document.documentElement.appendChild(style);
  }

  function withMainWSMode0(fn) {
    const ws = typeof Entry.getMainWS === 'function' ? Entry.getMainWS() : null;
    const oldGetMode = ws && ws.getMode;

    if (ws && typeof oldGetMode === 'function') {
      try {
        ws.getMode = function patchedGetModeForAddRef() { return 0; };
        return fn();
      } finally {
        ws.getMode = oldGetMode;
      }
    }

    return fn();
  }

  function patchModeForAddRef() {
    if (Entry.__functionVariableRefPatchModePatched) return;
    Entry.__functionVariableRefPatchModePatched = true;

    if (Entry.Code?.prototype?.createThread) {
      const originalCreateThread = Entry.Code.prototype.createThread;
      Entry.Code.prototype.createThread = function patchedCreateThread(...args) {
        return withMainWSMode0(() => originalCreateThread.apply(this, args));
      };
    }

    if (Entry.Code?.prototype?.load) {
      const originalLoad = Entry.Code.prototype.load;
      Entry.Code.prototype.load = function patchedLoad(...args) {
        return withMainWSMode0(() => originalLoad.apply(this, args));
      };
    }
  }

  function patchRescanTriggers() {
    const vc = Entry.variableContainer;

    // updateList는 자주 호출되므로 절대 감시하지 않음.
    // 함수 저장/편집 종료처럼 함수 JSON이 실제로 바뀌는 지점만 보조 감시.
    wrapMethod(vc, 'saveFunction', function afterSaveFunction() {
      scheduleRescanAfterStableDrop('saveFunction');
    });

    if (Entry.Func) {
      wrapMethod(Entry.Func, 'edit', function afterFuncEdit() {
        // 함수 진입 시 저장/복구 방식은 사용하지 않는다.
        // 전체 오브젝트 code + 전체 함수 content를 다시 수집해서 일반 ref가 사라지지 않게 한다.
        scheduleRescanAfterStableDrop('Func.edit');
        setTimeout(() => scheduleRescanAfterStableDrop('Func.edit.late'), 650);
      });

      wrapMethod(Entry.Func, 'save', function afterFuncSave() {
        scheduleRescanAfterStableDrop('Func.save');
      });

      wrapMethod(Entry.Func, 'endEdit', function afterFuncEndEdit() {
        scheduleRescanAfterStableDrop('Func.endEdit');
      });
    }
  }

  const IMMEDIATE_COMMAND_NUMBERS = new Set([
    '105',
    '118',
    '101',
    '113',
    '119',
    '102',
    '107',
  ]);

  let immediateCommandScanTimer = null;
  let immediateCommandNumbers = new Set();
  let commandProxyRefreshTimer = null;

  function installCommandDoProxyScanWatcher() {
    if (Entry.__functionVariableRefPatchCommandWatcherInstalled) return;
    Entry.__functionVariableRefPatchCommandWatcherInstalled = true;

    proxyEntryCommandDos();

    // Entry.Command가 나중에 추가/교체되는 경우 보완
    let refreshCount = 0;
    commandProxyRefreshTimer = setInterval(() => {
      proxyEntryCommandDos();
      refreshCount++;
      if (refreshCount > 40) {
        clearInterval(commandProxyRefreshTimer);
        commandProxyRefreshTimer = null;
      }
    }, 500);
  }

  function proxyEntryCommandDos() {
    const command = Entry.Command;

    if (!command || typeof command !== 'object') return;

    Object.keys(command).forEach((num) => {
      const commandItem = command[num];

      if (!commandItem || typeof commandItem.do !== 'function') return;
      if (commandItem.__entryFuncVarRefDoProxyInstalled) return;

      const originalDo = commandItem.do;

      const handler = {
        apply(target, thisArg, argumentsList) {
          onEntryCommandDoDetected(num, argumentsList);
          return target.apply(thisArg, argumentsList);
        },
      };

      commandItem.do = new Proxy(originalDo, handler);
      commandItem.__entryFuncVarRefDoProxyInstalled = true;
      commandItem.__entryFuncVarRefOriginalDo = originalDo;
    });
  }

  function onEntryCommandDoDetected(num, argumentsList) {
    const commandNumber = String(num);

    if (IMMEDIATE_COMMAND_NUMBERS.has(commandNumber)) {
      // 지정 번호만 감지 즉시 다시 검사
      scheduleImmediateCommandRescan(commandNumber);
    }
  }

  function scheduleImmediateCommandRescan(commandNumber) {
    immediateCommandNumbers.add(String(commandNumber));

    if (immediateCommandScanTimer) clearTimeout(immediateCommandScanTimer);

    immediateCommandScanTimer = setTimeout(() => {
      const nums = [...immediateCommandNumbers];
      immediateCommandNumbers.clear();
      immediateCommandScanTimer = null;

      const now = Date.now();
      if (now - lastRescanAt < 80) return;
      lastRescanAt = now;

      rescanAllRefs('Command.do.immediate', { commandNumbers: nums });
    }, 40);
  }


  let rescanTimer = null;
  let lastRescanAt = 0;

  function scheduleRescanAfterStableDrop(
    reason = 'interaction',
    moved = false,
    elapsed = 0,
    commandNumbers = []
  ) {
    if (rescanTimer) clearTimeout(rescanTimer);

    rescanTimer = setTimeout(() => {
      rescanTimer = null;

      // 너무 짧은 간격의 중복 스캔 방지
      const now = Date.now();
      if (now - lastRescanAt < 350) return;

      lastRescanAt = now;
      rescanAllRefs(reason, { moved, elapsed, commandNumbers });
    }, 260);
  }

  function wrapMethod(obj, name, after, before) {
    if (!obj || typeof obj[name] !== 'function') return;

    const key = `__entryFuncVarRefPatchWrapped_${name}`;
    if (obj[key]) return;

    const original = obj[name];

    obj[name] = function wrappedMethod(...args) {
      before && before.apply(this, args);
      const ret = original.apply(this, args);
      after && after.apply(this, args);
      return ret;
    };

    obj[key] = true;
  }

  function collectObjects() {
    const set = new Set();
    const c = Entry.container;

    const add = (obj) => {
      if (!obj) return;

      if (Array.isArray(obj)) {
        obj.forEach(add);
        return;
      }

      if (typeof obj !== 'object') return;

      // id/name/script/code/entity 중 하나라도 있으면 Entry object 후보로 취급
      if (
        obj.id ||
        obj.name ||
        obj.script ||
        obj.script_ ||
        obj.code ||
        obj.entity ||
        obj.object ||
        obj.object_
      ) {
        set.add(obj);
      }
    };

    const addValues = (v) => {
      if (!v) return;

      if (Array.isArray(v)) {
        v.forEach(add);
      } else if (typeof v === 'object') {
        Object.values(v).forEach(add);
      }
    };

    add(Entry.playground?.object);

    [
      c?.objects_,
      c?.objects,
      c?.objectList_,
      c?._objects,
      c?.objectList,
      c?.objectMap,
      c?.entityMap,
      Entry.stage?.objects,
      Entry.stage?.objects_,
      Entry.project?.objects,
      Entry.project?.objects_,
    ].forEach(addValues);

    [
      c?.getAllObjects,
      c?.getObjects,
      c?.getObjectList,
      c?.getEntities,
    ].forEach((fn) => {
      if (typeof fn !== 'function') return;

      try {
        addValues(fn.call(c));
      } catch (_) {}
    });

    return [...set];
  }

  function getObjectCode(obj) {
    return (
      obj?.script ||
      obj?.script_ ||
      obj?.code ||
      obj?.code_ ||
      obj?.entity?.script ||
      obj?.entity?.script_ ||
      obj?.entity?.code ||
      obj?.object?.script ||
      obj?.object?.script_ ||
      obj?.object?.code ||
      obj?.object_?.script ||
      obj?.object_?.script_ ||
      obj?.object_?.code ||
      null
    );
  }

  function collectCodes() {
    const set = new Set();

    const addCode = (code) => {
      if (!code) return;

      // 실제 Entry.Code
      if (typeof code.getBlockList === 'function') {
        set.add(code);
        return;
      }

      // Entry.Code가 아닌 JSON/script 배열은 normal JSON scanner에서 처리
      if (Array.isArray(code) || typeof code === 'string') {
        set.add(code);
      }
    };

    collectObjects().forEach((obj) => {
      addCode(getObjectCode(obj));
    });

    const boardCode =
      Entry.playground?.board?.code ||
      Entry.getMainWS?.()?.board?.code ||
      Entry.getMainWS?.()?.overlayBoard?.code ||
      Entry.Command?.editor?.board?.code;

    addCode(boardCode);

    return [...set];
  }

  function getAddRefKeyFromFunction(fn) {
    if (typeof fn !== 'function') return null;
    const src = Function.prototype.toString.call(fn);
    const m = src.match(/\.addRef\s*\(\s*['"]([^'"]+)['"]\s*,/);
    return m?.[1] || null;
  }

  function clearAllRefs() {
    const vc = Entry.variableContainer;

    ['_variableRefs', '_messageRefs', '_functionRefs'].forEach((key) => {
      if (Array.isArray(vc[key])) vc[key].length = 0;
    });
  }

  function getRefKey(ref) {
    const block = ref?.block;
    const object = ref?.object;
    const params = Array.isArray(block?.params)
      ? block.params.map((p) => getParamRawId(p)).join('|')
      : '';

    return [
      ref?.isInFunc ? 'func' : 'object',
      String(ref?.funcId || ''),
      String(object?.id || object?.name || ''),
      String(block?.id || ''),
      String(block?.type || ''),
      params,
    ].join('::');
  }

  function getParamRawId(param) {
    if (typeof param === 'string' || typeof param === 'number') return String(param);
    if (!param || typeof param !== 'object') return null;

    return (
      param.id ||
      param.id_ ||
      param.value ||
      param.variableId ||
      param.variable_id ||
      param.listId ||
      param.list_id ||
      param.params?.[0] ||
      null
    );
  }

  function getKnownRefIdSet() {
    const vc = Entry.variableContainer;
    const ids = new Set();

    const add = (v) => {
      if (v === undefined || v === null || v === '') return;
      ids.add(String(v));
    };

    const addFromItem = (item) => {
      if (!item) return;
      add(item.id_);
      add(item.id);
      add(item.value);
      add(item.variableId);
      add(item.listId);
    };

    (vc.variables_ || []).forEach(addFromItem);
    (vc.lists_ || []).forEach(addFromItem);
    Object.values(vc.variables_ || {}).forEach(addFromItem);
    Object.values(vc.lists_ || {}).forEach(addFromItem);

    return ids;
  }

  function getReferenceCandidateIndexes(type) {
    switch (type) {
      case 'get_variable':
      case 'set_variable':
      case 'change_variable':
      case 'show_variable':
      case 'hide_variable':
      case 'length_of_list':
      case 'show_list':
      case 'hide_list':
        return [0, 1, 2, 3];

      case 'add_value_to_list':
      case 'is_included_in_list':
      case 'remove_value_from_list':
      case 'insert_value_to_list':
      case 'change_value_list_index':
        // 대부분 리스트 id는 params[1]에 있음. 템플릿 차이를 대비해 주변도 검사.
        return [1, 2, 0, 3];

      default:
        return [0, 1, 2, 3];
    }
  }

  function extractReferenceIdFromParams(type, params) {
    if (!Array.isArray(params)) return null;

    const knownIds = getKnownRefIdSet();
    const indexes = getReferenceCandidateIndexes(type);

    // 1순위: 실제 변수/리스트 id 목록과 일치하는 params 항목
    for (const idx of indexes) {
      const raw = getParamRawId(params[idx]);

      if (raw !== null && knownIds.has(String(raw))) {
        return String(raw);
      }
    }

    // 2순위: 타입별 우선 인덱스의 값
    for (const idx of indexes) {
      const raw = getParamRawId(params[idx]);

      if (raw !== null) {
        return String(raw);
      }
    }

    return null;
  }

  function getObjectNameForRef(obj) {
    return (
      obj?.name ||
      obj?.entity?.name ||
      obj?.object?.name ||
      obj?.object_?.name ||
      '오브젝트'
    );
  }

  function makePseudoObjectBlock(node, refId, object, path) {
    const blockId = node.id || `__object_${object?.id || getObjectNameForRef(object)}_${path.join('_')}`;

    return {
      id: blockId,
      type: node.type,
      params: [refId, ...(Array.isArray(node.params) ? node.params : [])],
      data: node,
      view: null,
      __isPseudoObjectBlock: true,
    };
  }

  function addNormalJSONRefsFromCode(refs, codeJson, object) {
    const content = normalizeFunctionContent(codeJson);
    let added = 0;

    function scan(node, path) {
      if (!node) return;

      if (Array.isArray(node)) {
        node.forEach((item, index) => scan(item, path.concat(index)));
        return;
      }

      if (typeof node !== 'object') return;

      if (VARIABLE_BLOCK_TYPES.has(node.type)) {
        const refId = extractReferenceIdFromParams(node.type, node.params);

        if (refId) {
          const block = makePseudoObjectBlock(node, refId, object, path);
          const ref = {
            object: object?.entity ? object : {
              ...object,
              entity: true,
              name: getObjectNameForRef(object),
              generateView: object?.generateView || function() {},
            },
            block,
            isInFunc: false,
            refSource: 'objectJSON',
            var1: refId,
          };

          const key = getRefKey(ref);
          if (!refs.some((x) => getRefKey(x) === key)) {
            refs.push(ref);
            added++;
          }
        }
      }

      Object.keys(node).forEach((key) => scan(node[key], path.concat(key)));
    }

    scan(content, []);
    return added;
  }

  function rebuildNormalBlockRefs() {
    const vc = Entry.variableContainer;
    let scannedBlocks = 0;
    let addedRefs = 0;

    // 실제 Entry.Code 기반 ref
    collectCodes().forEach((code) => {
      if (!code) return;

      if (typeof code.getBlockList !== 'function') {
        return;
      }

      let blocks = [];

      try {
        blocks = code.getBlockList(false) || [];
      } catch (e) {
        console.warn(TAG, '일반 블록 getBlockList 실패:', e);
      }

      blocks.forEach((block) => {
        if (!block) return;
        scannedBlocks++;

        const events = block.events?.dataAdd || Entry.block?.[block.type]?.events?.dataAdd || [];

        events.forEach((fn) => {
          const refKey = getAddRefKeyFromFunction(fn);

          if (refKey && Array.isArray(vc[refKey]) && typeof vc.addRef === 'function') {
            try {
              vc.addRef(refKey, block);
              addedRefs++;
            } catch (e) {
              console.warn(TAG, '일반 블록 addRef 실패:', refKey, block?.type, e);
            }
          }
        });
      });
    });

    // 함수 편집 모드에서 실제 object code를 못 잡는 경우를 대비한 JSON fallback
    collectObjects().forEach((object) => {
      const code = getObjectCode(object);
      if (!code || typeof code.getBlockList === 'function') return;
      addedRefs += addNormalJSONRefsFromCode(vc._variableRefs || (vc._variableRefs = []), code, object);
    });

    return { scannedBlocks, addedRefs };
  }

  function getFunctionJSONList() {
    const vc = Entry.variableContainer;
    const map = new Map();

    const cleanId = (id) => String(id || '').replace(/^func_/, '');

    const put = (item, preferLive = false) => {
      if (!item) return;

      const rawId =
        item.id ||
        item.id_ ||
        item.funcId ||
        item.functionId ||
        item.key;

      if (!rawId) return;

      const id = cleanId(rawId);
      const prev = map.get(id);

      if (!prev || preferLive || prev.__fromGetFunctionJSON) {
        map.set(id, {
          ...item,
          id,
          __fromGetFunctionJSON: !preferLive,
          __liveContent: preferLive,
        });
      }
    };

    // 1) 기존 Entry API 결과
    if (typeof vc.getFunctionJSON === 'function') {
      try {
        const list = vc.getFunctionJSON();
        if (Array.isArray(list)) {
          list.forEach((item, index) => {
            put({
              ...item,
              id:
                item?.id ||
                item?.id_ ||
                item?.funcId ||
                item?.functionId ||
                `index_${index}`,
            });
          });
        }
      } catch (e) {
        console.warn(TAG, 'getFunctionJSON 실패, fallback 사용:', e);
      }
    }

    // 2) functions_의 live Code 내용도 항상 병합
    //    getFunctionJSON이 저장된 내용만 반환하거나, 함수 편집 중 내용이 늦게 반영되는 경우 보완
    if (vc.functions_ && typeof vc.functions_ === 'object') {
      Object.values(vc.functions_).forEach((func) => {
        put({
          id: func.id,
          type: func.type,
          name: func.name,
          description: func.description,
          content:
            typeof func.content?.toJSON === 'function'
              ? func.content.toJSON()
              : func.content,
        }, true);
      });
    }

    // 3) 현재 편집 중인 함수는 저장 전이어도 반드시 포함
    const targetFunc = Entry.Func?.targetFunc;
    if (targetFunc?.id && targetFunc?.content) {
      put({
        id: targetFunc.id,
        type: targetFunc.type,
        name: targetFunc.name,
        description: targetFunc.description,
        content:
          typeof targetFunc.content?.toJSON === 'function'
            ? targetFunc.content.toJSON()
            : targetFunc.content,
      }, true);
    }

    return [...map.values()];
  }

  function getFunctionById(funcId) {
    const vc = Entry.variableContainer;
    if (!funcId) return null;

    const cleanId = String(funcId).replace(/^func_/, '');

    try {
      if (typeof vc.getFunction === 'function') return vc.getFunction(cleanId);
    } catch (_) {}

    return vc.functions_?.[cleanId] || null;
  }

  function normalizeFunctionContent(content) {
    if (!content) return [];

    if (typeof content === 'string') {
      try {
        return JSON.parse(content);
      } catch (_) {
        return [];
      }
    }

    if (typeof content.toJSON === 'function') {
      try {
        return content.toJSON();
      } catch (_) {
        return [];
      }
    }

    return content;
  }

  function extractVariableIdFromParams(type, params) {
    return extractReferenceIdFromParams(type, params);
  }

  function makePseudoFunctionObject(funcId, funcName) {
    return {
      id: `__entry_function_${funcId}`,
      name: funcName || `함수 ${funcId}`,
      entity: true,
      generateView() {
        if (!this.thumbnailView_) {
          const span = document.createElement('span');
          span.textContent = 'ƒ';
          span.className = 'entryFuncRefThumb';
          this.thumbnailView_ = span;
        }
      },
      thumbnailView_: null,
    };
  }

  function makePseudoFunctionBlock(node, variableId, funcId, funcIndex, path) {
    return {
      id: node.id || `__func_${funcId}_${funcIndex}_${path.join('_')}`,
      type: node.type,
      params: [variableId, ...(Array.isArray(node.params) ? node.params : [])],
      data: node,
      view: null,
      __isPseudoFunctionBlock: true,
    };
  }

  function addFunctionVariableRefs() {
    const vc = Entry.variableContainer;
    const refs = vc._variableRefs || (vc._variableRefs = []);
    const functionJSON = getFunctionJSONList();
    let added = 0;

    functionJSON.forEach((funcJson, funcIndex) => {
      const funcId =
        funcJson?.id ||
        funcJson?.id_ ||
        funcJson?.funcId ||
        funcJson?.functionId ||
        `index_${funcIndex}`;

      const funcObj = getFunctionById(funcId);
      const funcName =
        funcJson?.description ||
        funcJson?.name ||
        funcObj?.description ||
        `함수 ${funcIndex + 1}`;

      const content = normalizeFunctionContent(funcJson?.content);
      const pseudoObject = makePseudoFunctionObject(funcId, funcName);

      function scan(node, currentPath) {
        if (!node) return;

        if (Array.isArray(node)) {
          node.forEach((item, index) => scan(item, currentPath.concat(index)));
          return;
        }

        if (typeof node !== 'object') return;

        if (VARIABLE_BLOCK_TYPES.has(node.type)) {
          const variableId = extractVariableIdFromParams(node.type, node.params);

          if (variableId) {
            const block = makePseudoFunctionBlock(node, variableId, funcId, funcIndex, currentPath);

            const duplicated = refs.some((ref) => (
              ref &&
              ref.isInFunc === true &&
              String(ref.funcId) === String(funcId) &&
              String(ref.block?.id) === String(block.id) &&
              String(ref.block?.params?.[0]) === String(variableId)
            ));

            if (!duplicated) {
              refs.push({
                object: pseudoObject,
                block,
                funcId,
                funcIndex,
                funcName,
                isInFunc: true,
                refSource: 'functionJSON',
                var1: variableId,
              });
              added++;
            }
          }
        }

        Object.keys(node).forEach((key) => scan(node[key], currentPath.concat(key)));
      }

      scan(content, []);
    });

    return { functionCount: functionJSON.length, addedFunctionRefs: added };
  }

  function includesParam(params, id) {
    if (!Array.isArray(params)) return false;

    return params.some((p) => {
      if (p === id || String(p) === String(id)) return true;

      if (p && typeof p === 'object') {
        return (
          p.id === id ||
          p.id_ === id ||
          p.value === id ||
          String(p.id) === String(id) ||
          String(p.id_) === String(id) ||
          String(p.value) === String(id)
        );
      }

      return false;
    });
  }

  function getVariableId(variable) {
    return variable?.id_ || variable?.id || variable?.value || null;
  }

  function getBlockLabel(prefix, type) {
    const langKey = `${prefix}_${type}`;
    return Lang?.Blocks?.[langKey] || Lang?.Blocks?.[type] || type || 'block';
  }

  function selectFunctionBlockLater(caller) {
    const funcId = caller.funcId;
    const blockId = caller.block?.id;

    try {
      Entry.Func.edit(funcId);
    } catch (e) {
      console.warn(TAG, 'Entry.Func.edit 실패:', funcId, e);
      return;
    }

    setTimeout(() => {
      try {
        const func = getFunctionById(funcId);
        const realBlock = func?.content?.findById?.(blockId);

        if (realBlock?.view) {
          const board =
            typeof _ !== 'undefined'
              ? _.result(realBlock.view, 'getBoard')
              : realBlock.view.getBoard?.();

          if (board) board.setSelectedBlock(realBlock.view);
        }

        Entry.playground?.toggleOnVariableView?.();
        Entry.playground?.changeViewMode?.('variable');
      } catch (e) {
        console.warn(TAG, '함수 내부 블록 선택 실패:', e);
      }
    }, 120);
  }

  function patchRenderVariableReference() {
    const vc = Entry.variableContainer;

    vc.renderVariableReference = function patchedRenderVariableReference(variable) {
      const variableId = getVariableId(variable);
      const hasInFunction =
        typeof this.hasParamBlockInFunction === 'function'
          ? this.hasParamBlockInFunction(variableId)
          : false;

      const callers = (this._variableRefs || []).filter(({ block }) =>
        includesParam(block?.params, variableId)
      );

      const usedWrapper = Entry.createElement('div').addClass('use_obj');
      const usedSubject = Entry.createElement('span').addClass('box_sjt').appendTo(usedWrapper);
      const listView = Entry.createElement('ul').addClass('obj_list').appendTo(usedWrapper);

      if (callers.length) {
        usedSubject.textContent = Entry.Utils.stringFormat(
          Lang.Workspace.use_block_objects1,
          callers.length
        );

        const fragment = document.createDocumentFragment();

        callers.forEach((caller) => {
          const element = Entry.createElement('li');
          const isInFunc = caller.isInFunc === true;

          if (isInFunc) {
            element.addClass('entryFuncVariableRef');

            Entry.createElement('span').addClass('entryFuncRefBadge').appendTo(element).textContent = '함수';

            Entry.createElement('span').addClass('text').appendTo(element).textContent =
              `${caller.funcName || caller.funcId} : ${getBlockLabel('VARIABLE', caller.block?.type)}`;

            element.bindOnClick((e) => {
              e.stopPropagation();
              selectFunctionBlockLater(caller);
            });

            fragment.appendChild(element);
            return;
          }

          const object = caller.object;
          if (!object?.entity) return;

          !object.thumbnailView_ && object.generateView?.();

          if (object.thumbnailView_) {
            const thumb = object.thumbnailView_.cloneNode();
            thumb.addClass?.('thmb');
            element.appendChild(thumb);
          }

          Entry.createElement('span').addClass('text').appendTo(element).textContent =
            `${object.name} : ${getBlockLabel('VARIABLE', caller.block?.type)}`;

          element.variable = variable;

          element.bindOnClick((e) => {
            e.stopPropagation();

            if (Entry.playground.object !== object) {
              Entry.container.selectObject();
              Entry.container.selectObject(object.id, true);
            }

            const block = caller.block;
            const board =
              typeof _ !== 'undefined'
                ? _.result(block.view, 'getBoard')
                : block.view?.getBoard?.();

            if (board) board.setSelectedBlock(block.view);

            Entry.playground.toggleOnVariableView();
            Entry.playground.changeViewMode('variable');
          });

          fragment.appendChild(element);
        });

        listView.appendChild(fragment);
      } else {
        usedSubject.textContent = Entry.Utils.stringFormat(
          Lang.Workspace.use_block_objects2,
          callers.length
        );

        Entry.createElement('div').addClass('caution_dsc').appendTo(listView).textContent =
          Lang.Workspace.no_use;
      }

      if (hasInFunction || callers.some((caller) => caller.isInFunc)) {
        Entry.createElement('div')
          .addClass('used_function_dsc')
          .appendTo(listView).textContent = Lang.Workspace.use_block_function || '함수 안에서 사용 중';
      }

      this.variableSettingView && this.variableSettingView.appendChild(usedWrapper);
      this.listSettingView && this.listSettingView.appendChild(usedWrapper);
    };
  }

  function patchRenderMessageReferenceForFuncFlag() {
    const vc = Entry.variableContainer;

    vc.renderMessageReference = function patchedRenderMessageReference(message) {
      const messageId = message.id;

      const hasInFunction =
        typeof this.hasParamBlockInFunction === 'function'
          ? this.hasParamBlockInFunction(messageId)
          : false;

      const callers = (this._messageRefs || []).filter(({ block }) =>
        includesParam(block?.params, messageId)
      );

      message.usedView && $(message.usedView).remove();

      const usedWrapper = Entry.createElement('div').addClass('use_block');
      const boxSubject = Entry.createElement('span').addClass('box_sjt').appendTo(usedWrapper);

      if (callers.length) {
        boxSubject.textContent = Entry.Utils.stringFormat(
          Lang.Workspace.use_block_objects1,
          callers.length
        );

        const listView = Entry.createElement('ul').addClass('obj_list').appendTo(usedWrapper);
        const fragment = document.createDocumentFragment();

        callers.forEach((caller) => {
          const element = Entry.createElement('li');

          if (caller.isInFunc) {
            element.addClass('entryFuncMessageRef');

            Entry.createElement('span').addClass('entryFuncRefBadge').appendTo(element).textContent = '함수';

            Entry.createElement('span').addClass('text').appendTo(element).textContent =
              `${caller.funcName || caller.funcId} : ${getBlockLabel('START', caller.block?.type)}`;

            element.bindOnClick((e) => {
              e.stopPropagation();
              selectFunctionBlockLater(caller);
            });

            fragment.appendChild(element);
            return;
          }

          const object = caller.object;
          if (!object?.entity) return;

          !object.thumbnailView_ && object.generateView?.();

          if (object.thumbnailView_) {
            const thumb = element.appendChild(object.thumbnailView_.cloneNode());
            thumb.addClass?.('thmb');
          }

          Entry.createElement('span').addClass('text').appendTo(element).textContent =
            `${object.name} : ${getBlockLabel('START', caller.block?.type)}`;

          element.bindOnClick((e) => {
            e.stopPropagation();

            if (Entry.playground.object !== object) {
              Entry.container.selectObject();
              Entry.container.selectObject(object.id, true);
            }

            const block = caller.block;
            const board =
              typeof _ !== 'undefined'
                ? _.result(block.view, 'getBoard')
                : block.view?.getBoard?.();

            if (board) board.setSelectedBlock(block.view);

            Entry.playground.toggleOnVariableView();
            Entry.playground.changeViewMode('variable');
          });

          fragment.appendChild(element);
        });

        listView.appendChild(fragment);
      } else {
        Entry.createElement('div').addClass('caution_dsc').appendTo(usedWrapper).textContent =
          Lang.Workspace.no_use;

        boxSubject.textContent = Entry.Utils.stringFormat(
          Lang.Workspace.use_block_objects2,
          callers.length
        );
      }

      if (hasInFunction || callers.some((caller) => caller.isInFunc)) {
        Entry.createElement('div')
          .addClass('used_function_dsc')
          .appendTo(usedWrapper).textContent = Lang.Workspace.use_block_function || '함수 안에서 사용 중';
      }

      message.usedView = usedWrapper;
      message.listElement.appendChild(usedWrapper);
    };
  }

  function rescanAllRefs(reason = 'manual', meta = {}) {
    if (!Entry.variableContainer) return;

    clearAllRefs();

    const normal = rebuildNormalBlockRefs();
    const func = addFunctionVariableRefs();

    try {
      Entry.variableContainer.updateList?.();
      Entry.dispatchEvent?.('changeFuncVariableListSize');
    } catch (_) {}

    const result = {
      reason,
      ...meta,
      ...normal,
      ...func,
      variableRefs: Entry.variableContainer._variableRefs?.length || 0,
      messageRefs: Entry.variableContainer._messageRefs?.length || 0,
      functionRefs: Entry.variableContainer._functionRefs?.length || 0,
    };

    console.log(TAG, '참조 재스캔 완료:', result);
    return result;
  }

  installWhenReady();
})();
