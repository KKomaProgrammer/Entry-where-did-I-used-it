설치 방법
1. 이 ZIP을 압축 해제합니다.
2. Chrome 주소창에 chrome://extensions 를 입력합니다.
3. 우측 상단 개발자 모드를 켭니다.
4. 기존 버전이 설치되어 있으면 제거하거나, 새 폴더로 다시 '압축해제된 확장 프로그램을 로드'합니다.
5. 압축 해제한 폴더(entry_function_variable_ref_extension_v2)를 선택합니다.
6. playentry.org 프로젝트 편집 화면을 새로고침합니다.

v1.0.1 반영 사항
- 함수 배지가 텍스트보다 아래로 내려가던 문제를 수정했습니다.
- updateList 호출 때마다 재스캔하던 로직을 제거했습니다.
- 클릭/드래그 시작을 감지한 뒤 pointerup/mouseup/touchend/drop/dragend 이후 Entry 상태가 안정될 때 한 번만 재스캔합니다.
- 너무 짧은 간격의 중복 스캔은 350ms 제한으로 막았습니다.

수동 재스캔
Entry.__functionVariableRefPatchRescan()

v1.0.2 반영 사항
- 함수 편집 화면에 들어간 뒤에도 다른 참조가 보이도록 Entry.Func.edit() 이후 재스캔을 추가했습니다.
- Entry.variableContainer.getFunctionJSON() 결과뿐 아니라 Entry.variableContainer.functions_의 live content도 병합합니다.
- 현재 편집 중인 Entry.Func.targetFunc.content도 저장 전 상태까지 포함해서 스캔합니다.
- 기존 배지 위치 보정, 드롭 후 재스캔, 중복 스캔 제한은 그대로 유지했습니다.

v1.0.3 반영 사항
- Entry.Func.edit() 실행 직전 Entry.variableContainer._variableRefs를 임시 저장합니다.
- 함수 편집 화면이 로드되어 Entry.Func.targetFunc가 undefined가 아니게 되면, 임시 저장한 ref를 현재 _variableRefs에 병합 복구합니다.
- 복구 후에는 임시 저장값만 비웁니다. Entry.variableContainer._variableRefs 자체는 비우지 않습니다.
- 기존 기능과 스캔 타이밍, 배지 위치 보정은 그대로 유지했습니다.

v1.0.4 반영 사항
- 함수 편집 진입 전 Entry.variableContainer._variableRefs를 임시 저장하고, Entry.Func.targetFunc가 undefined가 아니게 된 뒤 복구합니다.
- 복구는 함수 편집 화면 진입 후 Entry 내부 정리가 끝나도록 안정화 지연을 둔 뒤 실행합니다.
- 복구 후에는 임시 저장값만 비웁니다. Entry.variableContainer._variableRefs는 비우지 않습니다.
- VARIABLE_BLOCK_TYPES에 아래 블록을 추가했습니다:
  add_value_to_list, is_included_in_list, length_of_list, show_list, hide_list,
  show_variable, hide_variable, remove_value_from_list, insert_value_to_list,
  change_value_list_index
- 그 외 기존 기능은 그대로 유지했습니다.

v1.0.5 반영 사항
- 클릭 자체를 기준으로 검사하지 않고 Entry.Command[번호].do를 Proxy로 감지하도록 변경했습니다.
- 즉시 검사 번호: 105, 118, 101, 113, 119, 102, 117, 107
- 위 번호들은 do 실행 감지 후 즉시 rescanAllRefs를 실행합니다.
- 그 외 Entry.Command do 실행은 감지만 해두고 pointerup/mouseup/touchend/drop/dragend 이후 안정화 시점에 검사합니다.
- 기존 함수 진입 전 ref 저장/진입 후 복구, VARIABLE_BLOCK_TYPES 추가, 배지 위치 보정은 그대로 유지했습니다.

v1.0.6 반영 사항
- 즉시 검사 번호에서 117을 제거했습니다.
- pointerup / mouseup / touchend / touchcancel / drop / dragend 이벤트 기반 검사를 제거했습니다.
- 이제 지정된 Entry.Command[번호].do Proxy 감지로만 즉시 재검사합니다.
- 함수 진입 시 _variableRefs 저장/복구 방식을 제거했습니다.
- 대신 전체 오브젝트 code와 전체 함수 content를 다시 수집하여, 함수 편집 화면에서도 일반 오브젝트 ref가 사라지지 않게 수정했습니다.
- 리스트 블록은 타입별 params 위치가 달라 obj_list에 안 뜨던 문제를 해결했습니다.
  특히 add_value_to_list / is_included_in_list / remove_value_from_list / insert_value_to_list / change_value_list_index는 params[1] 우선으로 리스트 id를 찾습니다.
- 다른 기능은 기존 v6/v5와 동일하게 유지했습니다.
