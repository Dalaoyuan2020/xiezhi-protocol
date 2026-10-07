// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title 学术体检 · 学术行为登记
/// @notice 一个行为上链，一个评分。投稿、结案、审稿、复现、认领、评分，每做一件事记一笔指纹。
///         任何人都能登记，链上记下登记人地址；读者按自己信任的登记人筛选。
///         链上只放哈希，论文、稿件与原始数据都留在链下。
contract ActionRegistry {
    bytes32 public constant SCORE = "SCORE";
    bytes32 public constant SUBMIT = "SUBMIT";
    bytes32 public constant REVIEW = "REVIEW";
    bytes32 public constant REPRODUCE = "REPRODUCE";
    bytes32 public constant CLAIM = "CLAIM";
    bytes32 public constant CLOSE = "CLOSE";  // 结案：拒稿、撤稿或录用，之后改投他刊不再算一稿多投

    struct Action {
        bytes32 subject;  // keccak256("openalex:<作者ID>") 或 keccak256("orcid:<ORCID>")
        bytes32 kind;     // SCORE / SUBMIT / CLOSE / REVIEW / REPRODUCE / CLAIM
        bytes32 content;  // 稿件、体检卡、审稿意见或复现日志的指纹
        bytes32 org;      // 机构标识的哈希（期刊、平台），个人行为可为 0
        bytes32 rule;     // SCORE：评分规则版本，如 "checkup-v0"；CLOSE：结案原因 "REJECTED" / "WITHDRAWN" / "ACCEPTED"
        uint16 value;     // SCORE 时为 0–100 分，其余为 0
        address recorder;
        uint64 time;
    }

    Action[] private _actions;
    mapping(bytes32 => uint256[]) private _bySubject;
    mapping(bytes32 => uint256[]) private _byContent;

    event Recorded(uint256 indexed id, bytes32 indexed subject, bytes32 indexed kind, bytes32 content, bytes32 org, uint16 value, address recorder);

    function record(bytes32 subject, bytes32 kind, bytes32 content, bytes32 org, bytes32 rule, uint16 value) public returns (uint256 id) {
        require(kind == SCORE || kind == SUBMIT || kind == CLOSE || kind == REVIEW || kind == REPRODUCE || kind == CLAIM, "unknown kind");
        if (kind == SCORE) require(value <= 100, "score>100");
        else require(value == 0, "value only for SCORE");
        id = _actions.length;
        _actions.push(Action(subject, kind, content, org, rule, value, msg.sender, uint64(block.timestamp)));
        _bySubject[subject].push(id);
        _byContent[content].push(id);
        emit Recorded(id, subject, kind, content, org, value, msg.sender);
    }

    /// @notice 评分的便捷写法
    function submitScore(bytes32 subject, uint16 score, bytes32 snapshot, bytes32 rule) external returns (uint256) {
        return record(subject, SCORE, snapshot, bytes32(0), rule, score);
    }

    function count() external view returns (uint256) {
        return _actions.length;
    }

    function getAction(uint256 id) external view returns (Action memory) {
        return _actions[id];
    }

    /// @notice 某个人的全部行为（时间线）
    function actionsOf(bytes32 subject) external view returns (Action[] memory) {
        return _collect(_bySubject[subject]);
    }

    /// @notice 同一指纹的全部记录。某机构有 SUBMIT 而没有对应 CLOSE，即「在审中」；
    ///         同一稿件在两家以上机构同时在审，提示「疑似一稿多投」（只信公开名单里的期刊地址所记）
    function actionsByContent(bytes32 content) external view returns (Action[] memory) {
        return _collect(_byContent[content]);
    }

    function _collect(uint256[] storage ids) private view returns (Action[] memory out) {
        out = new Action[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) out[i] = _actions[ids[i]];
    }
}
