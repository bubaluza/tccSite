const express = require('express');
const SerialPort = require('serialport');
const Readline = require('@serialport/parser-readline');
const regression = require('regression');

let test_json = require('./test.json');

const parser = new Readline();
const pcVoc = 0.4, pcIsc = 0.1, pcS0i = 0.6, pcS0f = 0.92, pcS1f = 0.4, Vth = 0.026;
let port, usbConnection = true, dataReady = false, progress, err = false, measuring = false, proccessData = {};


const app = express();

app.use(express.static('.'));
app.listen(8080, function () {
    console.log('app started');
});

//usb auto connection to ESP32

SerialPort.list((err, ports) => {
    ports.forEach((_port) => {
        if (_port.manufacturer === 'Silicon Labs') {
            port = new SerialPort(_port.comName, {baudRate: 115200});
            port.pipe(parser);
            usbConnection = true;
        }
    });
});

//routes
//todo: change to ws
app.get('/ajaxSet', (req, res) => {
    let rtn = {};
    rtn.chegou = false;
    if (!measuring) {
        // port.write('r');
        progress = 0;
        measuring = true;
    }

    res.send(rtn);
});


app.get('/ajaxConecao', (req, res) => {
    let rtn = {};
    rtn.usbConnection = usbConnection;
    res.send(rtn);
});

app.get('/ajaxMain', (req, res) => {
    // MeasureProccessMethod(test_json);
    // res.send({
    //              ...proccessData,
    //              chegou: true,
    //          })
    let rtn = {};
    if (err) {
        rtn.erro = true;
        err = false;
    } else if (dataReady) {
        rtn = {
            ...proccessData,
            chegou: true,
        };
        dataReady = false;
    } else {
        rtn.chegou = false;
        rtn.progresso = progress;
    }
    res.send(rtn);
});

parser.on('data', line => {
    let json;
    try {
        json = JSON.parse(line);
    } catch (e) {
        console.log('JSON parse Error');
        return;
    }

    if (json.data) {
        MeasureProccessMethod(json);
    } else if (json.progresso >= 0) {
        progress = json.progresso;
    } else if (json.terminouIv) {
        port.write('a');
    }

});

function MeasureProccessMethod(json) {
    try {
        let ivMeasure = json.dataIv;
        let dynamicMeasure = json.dataDin;

        ivMeasure = ivMeasure.filter(({voltage}) => voltage !== -1);

        let powerMeasure = ivMeasure.map(({voltage, current}) => ({
            voltage,
            current,
            power: voltage * current
        }));

        const {Vmp, Imp, Pmp} = calcPmp(powerMeasure);

        //dynamic measure
        let first_chav = dynamicMeasure.filter(({switching}) => switching === 0);
        let second_chav = dynamicMeasure.filter(({switching}) => switching === 1);
        const {C} = extractCap(first_chav, second_chav);
        console.log({C})

        //static measure
        Voc = ivMeasure[0].voltage;
        Isc = ivMeasure[ivMeasure.length - 1].current;
        const {Rso, Rsho} = extractRes(ivMeasure, Voc, Isc)
        const {Rs, Rsh} = calcCelik(Rsho, Rso, Vmp, Imp, Pmp, Voc, Isc);

        proccessData = {
            ivMeasure,
            dynamicMeasure,
            powerMeasure,
            Vmp,
            Imp,
            Pmp,
            Isc,
            Voc,
            Rs,
            Rp: Rsh,
            C
        };
        dataReady = true;
        measuring = false;
    } catch (e) {
        console.log(e);
        err = true;
    }
}


function extractRes(ivMeasure, Voc, Isc) {
    let points = [];
    ivMeasure.forEach(measure => {
        if (measure.current < (Isc * pcIsc)) {
            points = [...points, [measure.voltage, measure.current]];
        }
    });

    let regression_result = regression.linear(points, {precision: 5});
    let Rso = -1 / regression_result.equation[0];

    points = [];
    ivMeasure.reduceRight((lastPoint, measure) => {
        if (measure.voltage < (Voc * pcVoc) && (lastPoint.length === 0 || (measure.voltage !== lastPoint.voltage))) {
            points = [...points, [measure.voltage, measure.current]];
        }
        return measure;
    }, []);

    regression_result = regression.linear(points, {precision: 5});
    let Rsho = -1 / regression_result.equation[0];
    return {
        Rso,
        Rsho
    };
}

function extractCap(chav0, chav1) {
    //change to split
    let points = chav0.reduce((acc, el, index, arr) => {
        if ((index + 1) >= (arr.length * pcS0i) && (index + 1) < (arr.length * pcS0f)) {
            return [...acc, [el.time, el.voltage]];
        }
    }, []);

    let regression_result = regression.linear(points, {precision: 5});
    let S0 = regression_result.equation[0];

    points = chav1.reduce((acc, el, index, arr) => {
        if ((index + 1) >= (arr.length * pcS1f)) {
            return [...acc, [el.time, el.voltage]];
        }
    }, []);

    regression_result = regression.linear(points, {precision: 5});
    let S1 = regression_result.equation[0];

    let C = (-S0 * 0.000022) / (S0 - S1);
    return {C};
}

function calcPmp(powerMeasure) {
    console.log('começo')
    let maxPower = powerMeasure.reduce((max_power, power) => {
        if (max_power.power < power.power) {
            return power;
        }
        return max_power;
    }, {power: -1});
    console.log({maxPower})
    Vmp = maxPower.voltage;
    Imp = maxPower.current;
    Pmp = maxPower.power;
    return {
        Vmp,
        Imp,
        Pmp
    };
}

function calcCelik(Rsho, Rso, Vmp, Imp, Pmp, Voc, Isc) {
    let Rsh = Rsho;
    let n = (Vmp + Rso * Imp - Voc) / (Vth * (Math.log(Isc - Vmp / Rsho - Imp) - Math.log(Isc - Voc / Rsh) + Imp / (Isc - Voc / Rsho)));
    let Io = (Isc - Voc / Rsh) * Math.exp(-Voc / (n * Vth));
    let Rs = Rso - n * Vth * Math.exp(-Voc / (n * Vth)) / Io;
    // let Iph = Isc * (1 + Rs / Rsh) + Io * (Math.exp(Isc * Rs / (n * Vth) - 1));
    // let FF = (Vmp * Imp) / (Voc * Isc);
    return {
        Rsh,
        Rs
    };
}
